import { asyncDebounce, memoize, memoizeArgless, registerEmitter, type AddReceiver } from "@inrixia/helpers";
import type { IRecording, ITrack } from "musicbrainz-api";

import { type LunaUnload, type LunaUnloads, type Tracer } from "@luna/core";

import { listenerError, parseDate, safeTimeout } from "../../helpers";
import { isrcItems, musicBrainz } from "../../caches";
import { libTrace, unloads } from "../../index.safe";
import * as redux from "../../redux";
import { Album } from "../Album";
import { Artist } from "../Artist";
import { ContentBase, type TCoverOpts } from "../ContentBase";
import { PlaybackInfo, type MediaFormat, type TrackPlaybackInfo } from "../PlaybackInfo";
import { PlayState } from "../PlayState";
import { Quality } from "../Quality";
import { TidalApi } from "../TidalApi";
import { download, downloadProgress } from "./MediaItem.download.native";
import { availableTags, makeTags, MetaTags } from "./MediaItem.tags";
import type { MediaItemBase } from "./MediaItems";

export class MediaItem extends ContentBase {
	public static readonly trace: Tracer = libTrace.withSource(".MediaItem").trace;
	public static readonly availableTags = availableTags;

	private static _supportsSpatialAudio: boolean | undefined;
	public static get supportsSpatialAudio(): boolean | undefined {
		return MediaItem._supportsSpatialAudio;
	}

	/**
	 * An item that isn't in the redux store, from the same request TIDAL's LOAD_SINGLE_MEDIA_ITEM makes, through `TidalApi` so it is
	 * cached and shared with TIDAL's. Not dispatched through redux: interceptActionResp runs one load at a time, and the item isn't put in the store
	 */
	private static async fetchMediaItem(itemId: redux.ItemId, contentType: redux.ContentType): Promise<redux.MediaItem | undefined> {
		const item = contentType === "video" ? await TidalApi.video(itemId) : await TidalApi.track(itemId);
		// TIDAL adds contentType to the items it stores
		return item && <redux.MediaItem>{ item: { ...item, contentType }, type: contentType };
	}

	// #region Static Construction
	// Calls for the same item share one lookup, so repeated calls (e.g. a tracklist row that is reported again while scrolling) load it once
	public static async fromId(itemId?: redux.ItemId, contentType: redux.ContentType = "track"): Promise<MediaItem | undefined> {
		return itemId === undefined ? undefined : MediaItem.build(itemId, contentType);
	}
	/** Builds in flight by item, fromId and fromTMediaItems share them so an item never gets two instances */
	private static readonly building = new Map<string, Promise<MediaItem | undefined>>();
	/** The MediaItem of `itemId`, from the redux store's item, else `fetched` (item data a request already returned, e.g. an album's tracks), else loaded */
	private static build(itemId: redux.ItemId, contentType: redux.ContentType, fetched?: redux.MediaItem): Promise<MediaItem | undefined> {
		const key = String(itemId);
		let building = MediaItem.building.get(key);
		if (building === undefined) {
			building = MediaItem.construct(itemId, contentType, fetched).finally(() => MediaItem.building.delete(key));
			MediaItem.building.set(key, building);
		}
		return building;
	}
	private static async construct(itemId: redux.ItemId, contentType: redux.ContentType, fetched?: redux.MediaItem) {
		const item = await super.fromStore(itemId, "mediaItems", async (mediaItem) => {
			mediaItem ??= fetched ?? (await this.fetchMediaItem(itemId, contentType));
			if (mediaItem === undefined) return;
			// Prefer the type Tidal stored the item with, callers often default to "track" for videos
			return new MediaItem(itemId, mediaItem, mediaItem.type ?? contentType);
		});
		// Fetch real quality for spatial tracks
		if (item) await item.fetchBestQuality();
		return item;
	}
	/** The best item with `isrc`. The lookup (an id, the instances are `ContentBase`'s) is cached by `isrcItems`, calls in flight share one */
	public static fromIsrc(isrc: string): Promise<MediaItem | undefined> {
		let id = isrcItems.get(isrc);
		if (id === undefined) {
			id = MediaItem.findByIsrc(isrc).then((item) => item?.id);
			// A rejection drops it once sized
			isrcItems.set(isrc, id).catch(MediaItem.trace.err.withContext("fromIsrc", isrc));
		}
		return id.then((itemId) => MediaItem.fromId(itemId));
	}
	private static async findByIsrc(isrc: string): Promise<MediaItem | undefined> {
		let bestMediaItem: MediaItem | undefined = undefined;
		for await (const track of TidalApi.isrc(isrc)) {
			// If quality is higher than current best, set as best
			const maxTrackQuality = Quality.max(...Quality.fromMetaTags((track.attributes?.mediaTags ?? []) as redux.MediaMetadataTag[]));
			if (maxTrackQuality > (bestMediaItem?.bestQuality ?? Quality.Lowest)) {
				bestMediaItem = (await MediaItem.fromId(track.id)) ?? bestMediaItem;
				if ((bestMediaItem?.bestQuality ?? Quality.Lowest) >= Quality.Max) return bestMediaItem;
			}
		}
		return bestMediaItem;
	}
	public static async fromPlaybackContext(playbackContext?: redux.PlaybackContext) {
		// This has to be here to avoid ciclic requirements breaking
		playbackContext ??= PlayState.playbackContext;
		if (playbackContext?.actualProductId === undefined) return undefined;
		const mediaItem = await this.fromId(playbackContext.actualProductId, playbackContext.actualVideoQuality === null ? "track" : "video");
		// mediaItem?.setFormatAttrs({
		// 	bitDepth: playbackContext.bitDepth ?? undefined,
		// 	sampleRate: playbackContext.sampleRate ?? undefined,
		// 	duration: playbackContext.actualDuration ?? undefined,
		// 	codec: playbackContext.codec ?? undefined,
		// });
		return mediaItem;
	}
	public static async *fromIds(ids?: (redux.ItemId | undefined)[]) {
		if (ids === undefined) return;
		for (const itemId of ids.filter((id) => id !== undefined)) {
			// Skip items that fail to load so one bad item doesn't end iteration for the whole collection
			const mediaItem = await MediaItem.fromId(itemId).catch(MediaItem.trace.err.withContext("fromIds", itemId));
			if (mediaItem !== undefined) yield mediaItem;
		}
	}
	/** Items with their data (e.g. an album's or playlist's tracks from `TidalApi`) are built from it rather than loaded one at a time */
	public static async *fromTMediaItems(tMediaItems?: (MediaItemBase | redux.MediaItem | undefined)[]) {
		if (tMediaItems === undefined) return;
		for (const tMediaItem of tMediaItems.filter((tMediaItem) => tMediaItem !== undefined)) {
			const { item, type } = tMediaItem;
			// Only an id (e.g. a context menu's selection) is loaded through fromId
			const built = "title" in item ? MediaItem.build(item.id, type, <redux.MediaItem>tMediaItem) : MediaItem.fromId(item.id, type);
			const mediaItem = await built.catch(MediaItem.trace.err.withContext("fromTMediaItems", item.id));
			if (mediaItem !== undefined) yield mediaItem;
		}
	}

	// #region Listeners
	/** Triggered on "player/PRELOAD_ITEM" */
	public static onPreload: AddReceiver<MediaItem> = registerEmitter((emit) =>
		redux.intercept("player/PRELOAD_ITEM", unloads, async (item) => {
			if (item?.productId === undefined) return MediaItem.trace.warn("player/PRELOAD_ITEM intercepted without productId!", item);
			const mediaItem = await this.fromId(item.productId, item.productType);
			if (mediaItem === undefined) return;
			emit(mediaItem, listenerError("MediaItem.onPreload", mediaItem.trace.err.withContext("preloadItem.runListeners")));
		}),
	);
	/** Triggered on "playbackControls/MEDIA_PRODUCT_TRANSITION"*/
	public static onMediaTransition: AddReceiver<MediaItem> = registerEmitter((emit) =>
		redux.intercept(
			"playbackControls/MEDIA_PRODUCT_TRANSITION",
			unloads,
			asyncDebounce(async ({ playbackContext }: redux.InterceptPayload<"playbackControls/MEDIA_PRODUCT_TRANSITION">) => {
				const mediaItem = await this.fromPlaybackContext(playbackContext);
				if (mediaItem === undefined) return;

				// Detect spatial audio support based on actual playback
				if (mediaItem.tidalItem.audioModes?.includes("DOLBY_ATMOS") || mediaItem.tidalItem.audioModes?.includes("SONY_360RA")) {
					this._supportsSpatialAudio = playbackContext.actualAudioMode !== "STEREO";
				}

				await emit(mediaItem, listenerError("MediaItem.onMediaTransition", mediaItem.trace.err.withContext("mediaProductTransition.runListeners")));
			}),
		),
	);
	/**
	 * Triggered on "playbackControls/PREFILL_MEDIA_PRODUCT_TRANSITION"
	 * Warning! Not always called, **dont rely on this over onMediaTransition**
	 * */
	public static onPreMediaTransition: AddReceiver<MediaItem> = registerEmitter((emit) =>
		redux.intercept(
			"playbackControls/PREFILL_MEDIA_PRODUCT_TRANSITION",
			unloads,
			asyncDebounce(
				async ({ mediaProduct: { productId, productType } }: redux.InterceptPayload<"playbackControls/PREFILL_MEDIA_PRODUCT_TRANSITION">) => {
					const mediaItem = await this.fromId(productId, productType);
					if (mediaItem === undefined) return;
					await emit(mediaItem, listenerError("MediaItem.onPreMediaTransition", mediaItem.trace.err.withContext("prefillMPT.runListeners")));
				},
			),
		),
	);
	/** Triggered with the id of a track row (`data-track-id`) the pointer rests on for 100ms, e.g. to prefetch what it plays */
	public static onHover: AddReceiver<redux.ItemId> = registerEmitter((emit) => {
		let hoveredId: string | null = null;
		let cancelHover: (() => void) | undefined;
		const onPointerOver = (event: PointerEvent) => {
			const id = (<Element>event.target).closest?.("[data-track-id]")?.getAttribute("data-track-id") ?? null;
			if (id === hoveredId) return;
			hoveredId = id;
			cancelHover?.();
			if (id !== null)
				cancelHover = safeTimeout(unloads, () => emit(id, listenerError("MediaItem.onHover", this.trace.err.withContext("onHover"))), 100);
		};
		document.addEventListener("pointerover", onPointerOver, { passive: true });
		unloads.add(() => document.removeEventListener("pointerover", onPointerOver));
	});
	// #endregion
	public readonly tidalItem: Readonly<redux.Track>;
	public readonly trace: Tracer;

	constructor(
		public readonly id: redux.ItemId,
		tidalMediaItem: redux.MediaItem,
		public readonly contentType: redux.ContentType,
	) {
		super();
		// Ick, really need to figure out how to deal with videos
		this.tidalItem = tidalMediaItem?.item as redux.Track;
		if (this.tidalItem === undefined) MediaItem.trace.err.withContext("MediaItem constructor", this).throw("Tidal media item is undefined!");
		this.trace = MediaItem.trace.withSource(`[${this.tidalItem.title ?? id}]`).trace;
	}

	public play() {
		return PlayState.play(this.id);
	}

	/**
	 * Fetches the Tidal media item from the API to ensure properties like `bpm` are populated.
	 * Is idempotent so can be called multiple times without causing re-fetch.
	 */
	public fetchTidalMediaItem: () => Promise<void> = memoizeArgless(async () => {
		const tidalItem = await TidalApi.track(this.id);
		if (tidalItem !== undefined) (<redux.Track>this.tidalItem) = tidalItem;
	});

	// #region MusicBrainz
	public brainzItem: () => Promise<ITrack | undefined> = memoize(async () => {
		const releaseTrackFromRecording = async (recording: IRecording) => {
			// If a recording exists then fetch the full recording details including media for title resolution
			const release = await musicBrainz
				.json<IRecording>(`https://musicbrainz.org/ws/2/recording/${recording.id}?inc=releases+media+artist-credits+isrcs&fmt=json`)
				.then(({ title, releases }) => {
					// Release data can be wrong (eg a Japanese release tagged as English), only use releases where the track title matches the recording
					releases = releases?.filter((release) => MediaItem.baseTitle(release.media?.[0]?.tracks?.[0]?.title) === MediaItem.baseTitle(title));
					return releases?.filter((release) => release["text-representation"]?.language === "eng")[0] ?? releases?.[0];
				})
				.catch(this.trace.warn.withContext("brainzItem.getISRCRecordings"));
			if (release === undefined) return undefined;

			const releaseTrack = release.media?.[0]?.tracks?.[0];
			if (releaseTrack === undefined) return undefined;
			releaseTrack.recording ??= recording;
			return releaseTrack;
		};

		if (this.tidalItem.isrc !== undefined) {
			// Lookup the recording from MusicBrainz by ISRC
			const recording = await musicBrainz
				.json<{ recordings: IRecording[] }>(`https://musicbrainz.org/ws/2/isrc/${this.tidalItem.isrc}?inc=isrcs&fmt=json`)
				.then(({ recordings }) => this.matchBrainzRecording(recordings))
				.catch((err) => {
					// 404 means MusicBrainz doesn't know the ISRC, not worth a warning
					if (!err.message?.startsWith("404 ")) this.trace.warn.withContext("brainzItem.getISRCRecordings")(err);
				});

			const releaseTrack = recording && (await releaseTrackFromRecording(recording));
			if (releaseTrack !== undefined) return releaseTrack;
		}

		const album = await this.album();
		const albumRelease = await album?.brainzRelease();
		if (albumRelease === undefined) return;

		const volumeNumber = (this.tidalItem.volumeNumber ?? 1) - 1;
		const trackNumber = (this.tidalItem.trackNumber ?? 1) - 1;

		let brainzItem = albumRelease?.media?.[volumeNumber]?.tracks?.[trackNumber];
		// If this is not the english version of the release try to find the english version of the release track
		if (albumRelease?.["text-representation"]?.language !== "eng" && brainzItem?.recording !== undefined) {
			return (await releaseTrackFromRecording(brainzItem.recording)) ?? brainzItem;
		}
		return brainzItem;
	});
	/**
	 * MusicBrainz can link unrelated recordings to the same ISRC (eg audiobook chapters) and returns them in no stable order.
	 * Pick the recording whose title matches the Tidal title, otherwise the one closest in length, otherwise none.
	 */
	private matchBrainzRecording(recordings?: IRecording[]): IRecording | undefined {
		const lengthDiff = (recording: IRecording) =>
			this.tidalItem.duration && recording.length ? Math.abs(recording.length / 1000 - this.tidalItem.duration) : Infinity;
		const byLength = (a: IRecording, b: IRecording) => lengthDiff(a) - lengthDiff(b);

		const tidalTitle = MediaItem.baseTitle(this.tidalItem.title);
		const titleMatches = recordings?.filter((recording) => MediaItem.baseTitle(recording.title) === tidalTitle) ?? [];
		if (titleMatches.length !== 0) return titleMatches.sort(byLength)[0];

		const closest = recordings?.slice().sort(byLength)[0];
		if (closest !== undefined && lengthDiff(closest) <= MediaItem.brainzLengthTolerance) return closest;
	}
	private static readonly brainzLengthTolerance = 5;
	/**
	 * Title for comparing Tidal and MusicBrainz titles, ignores case, quote and hyphen style and anything in brackets.
	 */
	private static baseTitle(title?: string): string {
		const normalized = ContentBase.normalizeQuotes(title ?? "")
			.replace(/[‐‑‒–—]/g, "-")
			.toLowerCase()
			.trim();
		// Keep the brackets if the whole title is in brackets
		return normalized.replace(/\s*[([].*?[)\]]/g, "").trim() || normalized;
	}

	public brainzId: () => Promise<string | undefined> = memoize(async () => {
		const brainzItem = await this.brainzItem();
		return brainzItem?.recording?.id;
	});
	// #endregion

	// #region Async properties
	public album: () => Promise<Album | undefined> = memoize(async () => {
		if (this.tidalItem.album?.id) return Album.fromId(this.tidalItem.album?.id);
	});

	public artist: () => Promise<Artist | undefined> = memoize(async () => {
		if (this.tidalItem.artist?.id) return Artist.fromId(this.tidalItem.artist.id);
		if (this.tidalItem.artists?.[0]?.id) return Artist.fromId(this.tidalItem.artists?.[0].id);
		return (await this.album())?.artist();
	});

	public artists: () => Promise<Promise<Artist | undefined>[]> = memoize(async () => {
		if (this.tidalItem.artists) return this.tidalItem.artists.map((artist) => Artist.fromId(artist.id));
		return (await this.album())?.artists() ?? [];
	});

	public async *isrcs(): AsyncIterable<string> {
		if (this.contentType !== "track") return;
		const seen = new Set<string>();
		// Tracks loaded by some pages (eg album pages) have no isrc in the store, the API has it
		if (!this.tidalItem.isrc) await this.fetchTidalMediaItem().catch(this.trace.warn.withContext("isrcs.fetchTidalMediaItem"));
		if (this.tidalItem.isrc) {
			yield this.tidalItem.isrc;
			seen.add(this.tidalItem.isrc);
		}

		const brainzItem = await this.brainzItem();
		if (brainzItem?.recording?.isrcs) {
			for (const isrc of brainzItem.recording.isrcs) {
				if (seen.has(isrc)) continue;
				yield isrc;
				seen.add(isrc);
			}
		}
	}

	public isrc: () => Promise<string | undefined> = memoize(async () => {
		for await (const isrc of this.isrcs()) return isrc;
	});

	public lyrics: () => Promise<redux.Lyrics | undefined> = () => TidalApi.lyrics(this.id);

	public title: () => Promise<string> = memoize(async () => {
		const brainzItem = await this.brainzItem();
		return ContentBase.formatTitle(this.tidalItem.title, this.tidalItem.version ?? undefined, brainzItem?.title, brainzItem?.["artist-credit"]);
	});

	public releaseDate: () => Promise<Date | undefined> = memoize(async () => {
		let releaseDate = parseDate(this.tidalItem.releaseDate);
		if (releaseDate === undefined) {
			const brainzItem = await this.brainzItem();
			releaseDate = parseDate(brainzItem?.recording?.["first-release-date"]);
		}
		if (releaseDate === undefined) {
			const album = await this.album();
			releaseDate = parseDate(album?.releaseDate);
			if (releaseDate === undefined) {
				const brainzAlbum = await album?.brainzAlbum();
				releaseDate ??= parseDate(brainzAlbum?.date);
			}
		}
		return releaseDate ?? parseDate(this.tidalItem.streamStartDate);
	});

	/**
	 * "year-month-day"
	 */
	public releaseDateStr: () => Promise<string | undefined> = memoize(async () => {
		return (await this.releaseDate())?.toISOString().slice(0, 10);
	});

	public coverUrl: (opts?: TCoverOpts) => Promise<string | undefined> = memoize(async (opts) => {
		const coverUrl = ContentBase.getAlbumCoverUrl(this.tidalItem.album, opts);
		if (coverUrl) return coverUrl;
		const album = await this.album();
		return album?.coverUrl(opts);
	});

	public flacTags: () => Promise<MetaTags> = memoize(() => makeTags(this));

	// fetchTidalMediaItem asks the tracks API, a video id would get nothing or another item
	public async copyright(): Promise<string | undefined> {
		if (!this.tidalItem.copyright && this.contentType === "track")
			await this.fetchTidalMediaItem().catch(this.trace.warn.withContext("copyright.fetchTidalMediaItem"));
		return this.tidalItem.copyright ?? undefined;
	}
	public async bpm(): Promise<number | undefined> {
		if (!this.tidalItem.bpm && this.contentType === "track")
			await this.fetchTidalMediaItem().catch(this.trace.warn.withContext("bpm.fetchTidalMediaItem"));
		return this.tidalItem.bpm ?? undefined;
	}
	// #endregion

	// #region Properties
	public get trackNumber() {
		return this.tidalItem.trackNumber;
	}
	public get volumeNumber() {
		return this.tidalItem.volumeNumber;
	}
	public get replayGainPeak() {
		return this.tidalItem.peak;
	}
	public get replayGain(): number {
		if (this.contentType !== "track") return 0;
		return this.tidalItem.replayGain;
	}
	public get url(): string {
		return this.tidalItem.url;
	}
	public get qualityTags(): Quality[] {
		if (this.contentType !== "track") return [];
		const tags = Quality.fromMetaTags(this.tidalItem.mediaMetadata?.tags);
		const audioQuality = Quality.fromAudioQuality(this.tidalItem.audioQuality);
		// Placeholder for lossy tracks so TidalTags can display Low/Lowest
		if (tags.length === 0 && audioQuality !== undefined && audioQuality < Quality.High) tags.push(Quality.High);
		return tags;
	}
	public get bestQuality(): Quality {
		if (this.contentType !== "track") {
			this.trace.warn("MediaItem quality called on non-track!", this);
			return Quality.High;
		}
		const allTags = Quality.fromMetaTags(this.tidalItem.mediaMetadata?.tags);
		const hasSpatial = allTags.some((q) => q === Quality.Atmos || q === Quality.Sony630);
		// Filter out spatial audio tags - they can't display correct metadata
		const tags = allTags.filter((q) => q !== Quality.Atmos && q !== Quality.Sony630);
		// For spatial-only tracks, use the quality its stream is at (see fetchBestQuality) or default to HiRes
		if (hasSpatial && tags.length === 0) return Quality.fromAudioQuality(this.maxFormat?.audioQuality) ?? Quality.HiRes;
		return Quality.max(...tags, Quality.fromAudioQuality(this.tidalItem.audioQuality) ?? Quality.Lowest);
	}
	/** The format of the stream at `Quality.Max`, read by fetchBestQuality for spatial-only tracks. An oby store, kept current */
	private maxFormat?: MediaFormat;
	/** Fetches playbackInfo to get real quality for spatial-only tracks */
	public fetchBestQuality: () => Promise<Quality> = memoize(async () => {
		const allTags = Quality.fromMetaTags(this.tidalItem.mediaMetadata?.tags);
		const hasSpatial = allTags.some((q) => q === Quality.Atmos || q === Quality.Sony630);
		const nonSpatialTags = allTags.filter((q) => q !== Quality.Atmos && q !== Quality.Sony630);
		// Spatial-only tracks need playbackInfo lookup to get real quality, kept in the format across restarts
		if (hasSpatial && nonSpatialTags.length === 0) {
			const playback = this.playback();
			this.maxFormat = await playback.format();
			if (this.maxFormat.audioQuality === undefined) await playback.info();
		}
		return this.bestQuality;
	});
	public get duration(): number | undefined {
		return this.tidalItem.duration;
	}
	// #endregion

	// #region Max
	public max: () => Promise<MediaItem | undefined> = memoize(async () => {
		if (this.bestQuality >= Quality.Max) return;

		let bestMediaItem: MediaItem = this;
		for await (const isrc of this.isrcs()) {
			const mediaItem = await MediaItem.fromIsrc(isrc);
			if (mediaItem && mediaItem?.bestQuality > bestMediaItem.bestQuality) {
				bestMediaItem = mediaItem;
				if (bestMediaItem.bestQuality >= Quality.Max) break;
			}
		}

		// Dont return self
		if (bestMediaItem.id === this.id) return undefined;
		return bestMediaItem;
	});
	// #endregion

	// #region PlaybackInfo
	private readonly playbacks: { [K in redux.AudioQuality]?: PlaybackInfo } = {};
	/** This track's stream at `audioQuality`: its playbackInfo, file extension and format */
	public playback(audioQuality: redux.AudioQuality = Quality.Max.audioQuality): PlaybackInfo {
		return (this.playbacks[audioQuality] ??= new PlaybackInfo(this.id, audioQuality, this.duration));
	}
	public playbackInfo(audioQuality?: redux.AudioQuality): Promise<TrackPlaybackInfo | undefined> {
		return this.playback(audioQuality).info();
	}
	// #endregion

	// #region Download
	public async downloadProgress() {
		return downloadProgress(this.id);
	}
	public download: (path: string | string[], audioQuality?: redux.AudioQuality) => Promise<string> = asyncDebounce(
		async (path: string | string[], audioQuality?: redux.AudioQuality) => {
			if (this.contentType === "video") {
				const [playbackInfo, tags] = await Promise.all([PlaybackInfo.video(this.id), this.flacTags()]);
				if (!playbackInfo) throw new Error(`Video ${this.id} is not available`);
				return download(playbackInfo, path, tags);
			}
			const [playbackInfo, flagTags] = await Promise.all([this.playbackInfo(audioQuality), this.flacTags()]);
			if (!playbackInfo) throw new Error(`Track ${this.id} is not available`);
			return download(playbackInfo, path, flagTags);
		},
	);
	public async fileExtension(audioQuality?: redux.AudioQuality): Promise<string> {
		if (this.contentType === "video") return "mp4";
		return this.playback(audioQuality).fileExtension();
	}
	// #endregion

	// #region Format
	/** Calls `listener` with the format of this track's stream at `audioQuality` now (if known) and on every change */
	public withFormat(unloads: LunaUnloads, audioQuality: redux.AudioQuality, listener: (format: MediaFormat) => void): LunaUnload {
		return this.playback(audioQuality).withFormat(unloads, listener);
	}
	public updateFormat(audioQuality?: redux.AudioQuality, force?: true): Promise<MediaFormat | undefined> {
		return this.playback(audioQuality).updateFormat(force);
	}
	// #endregion
}
