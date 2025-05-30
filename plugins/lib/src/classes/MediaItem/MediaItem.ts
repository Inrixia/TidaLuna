import { asyncDebounce, memoize, memoizeArgless, registerEmitter, Semaphore, type AddReceiver, type Emit } from "@inrixia/helpers";
import type { IRecording, ITrack } from "musicbrainz-api";

import { ftch, ReactiveStore, type LunaUnload, type LunaUnloads, type Tracer } from "@luna/core";

import { getPlaybackInfo, parseDate, type PlaybackInfo } from "../../helpers";
import { libTrace, unloads } from "../../index.safe";
import * as redux from "../../redux";
import { Album } from "../Album";
import { Artist } from "../Artist";
import { ContentBase, type TImageSize } from "../ContentBase";
import { PlayState } from "../PlayState";
import { Quality } from "../Quality";
import { TidalApi } from "../TidalApi";
import { download, downloadProgress } from "./MediaItem.download.native";
import { availableTags, makeTags, MetaTags } from "./MediaItem.tags";
import { getStreamBytes, parseStreamFormat } from "./parseStreamFormat.native";

export type MediaFormat = {
	bitDepth?: number;
	sampleRate?: number;
	codec?: string;
	duration?: number;
	bytes?: number;
	bitrate?: number;
};
type MediaItemCache = {
	format?: { [K in redux.AudioQuality]?: MediaFormat };
};

export class MediaItem extends ContentBase {
	public static readonly trace: Tracer = libTrace.withSource(".MediaItem").trace;
	public static readonly availableTags = availableTags;

	private static cache = ReactiveStore.getStore("@luna/MediaItemCache");

	private static async fetchMediaItem(itemId: redux.ItemId, contentType: redux.ContentType) {
		// Supress missing content warning when programatically loading mediaItems
		const clearWarnCatch = redux.intercept("message/MESSAGE_WARN", unloads, (message) => {
			if (message?.message === "The content is no longer available") return true;
		});
		const { mediaItem } = await redux.interceptActionResp(
			() => redux.actions["content/LOAD_SINGLE_MEDIA_ITEM"]({ id: itemId, itemType: contentType }),
			unloads,
			["content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS"],
			["content/LOAD_SINGLE_MEDIA_ITEM_FAIL"],
		);
		clearWarnCatch();
		return mediaItem;
	}

	// #region Static Construction
	public static async fromId(itemId?: redux.ItemId, contentType: redux.ContentType = "track"): Promise<MediaItem | undefined> {
		if (itemId === undefined) return;
		// Prefetch mediaItemCache while constructing
		const mediaItemCache = MediaItem.cache.getReactive<MediaItemCache>(String(itemId), { format: {} });
		return super.fromStore(itemId, "mediaItems", async (mediaItem) => {
			mediaItem = mediaItem ??= await this.fetchMediaItem(itemId, contentType);
			if (mediaItem === undefined) return;
			return new MediaItem(itemId, mediaItem, contentType, await mediaItemCache);
		});
	}
	public static fromIsrc: (isrc: string) => Promise<MediaItem | undefined> = memoize(async (isrc) => {
		let bestMediaItem: MediaItem | undefined = undefined;
		for await (const track of TidalApi.isrc(isrc)) {
			// If quality is higher than current best, set as best
			const maxTrackQuality = Quality.max(...Quality.fromMetaTags(track.attributes.mediaTags as redux.MediaMetadataTag[]));
			if (maxTrackQuality > (bestMediaItem?.bestQuality ?? Quality.Lowest)) {
				bestMediaItem = (await MediaItem.fromId(track.id)) ?? bestMediaItem;
				if ((bestMediaItem?.bestQuality ?? Quality.Lowest) >= Quality.Max) return bestMediaItem;
			}
		}
		return bestMediaItem;
	});
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
			const mediaItem = await MediaItem.fromId(itemId);
			if (mediaItem !== undefined) yield mediaItem;
		}
	}
	public static async *fromTMediaItems(tMediaItems?: ({ item: { id: redux.ItemId }; type: redux.ContentType } | undefined)[]) {
		if (tMediaItems === undefined) return;
		for (const tMediaItem of tMediaItems.filter((tMediaItem) => tMediaItem !== undefined)) {
			const mediaItem = await MediaItem.fromId(tMediaItem.item.id, tMediaItem.type);
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
			emit(mediaItem, mediaItem.trace.err.withContext("preloadItem.runListeners"));
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

				await emit(mediaItem, mediaItem.trace.err.withContext("mediaProductTransition.runListeners"));
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
					await emit(mediaItem, mediaItem.trace.err.withContext("prefillMPT.runListeners"));
				},
			),
		),
	);
	// #endregion
	public readonly tidalItem: Readonly<redux.Track>;
	public readonly trace: Tracer;

	constructor(
		public readonly id: redux.ItemId,
		tidalMediaItem: redux.MediaItem,
		public readonly contentType: redux.ContentType,
		private readonly cache: MediaItemCache,
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
		(this.tidalItem as any) = await TidalApi.track(this.id);
	});

	// #region MusicBrainz
	public brainzItem: () => Promise<ITrack | undefined> = memoize(async () => {
		const releaseTrackFromRecording = async (recording: IRecording) => {
			// If a recording exists then fetch the full recording details including media for title resolution
			const release = await ftch
				.json<IRecording>(`https://musicbrainz.org/ws/2/recording/${recording.id}?inc=releases+media+artist-credits+isrcs&fmt=json`)
				.then(({ releases }) => releases?.filter((release) => release["text-representation"].language === "eng")[0] ?? releases?.[0])
				.catch(this.trace.warn.withContext("brainzItem.getISRCRecordings"));
			if (release === undefined) return undefined;

			const releaseTrack = release.media?.[0].tracks?.[0];
			releaseTrack.recording ??= recording;
			return releaseTrack;
		};

		if (this.tidalItem.isrc !== undefined) {
			// Lookup the recording from MusicBrainz by ISRC
			const recording = await ftch
				.json<{ recordings: IRecording[] }>(`https://musicbrainz.org/ws/2/isrc/${this.tidalItem.isrc}?inc=isrcs&fmt=json`)
				.then(({ recordings }) => recordings[0])
				.catch((err) => {
					if (err.message !== "Status code is 404") this.trace.warn.withContext("brainzItem.getISRCRecordings");
				});

			if (recording !== undefined) return releaseTrackFromRecording(recording);
		}

		const album = await this.album();
		const albumRelease = await album?.brainzRelease();
		if (albumRelease === undefined) return;

		const volumeNumber = (this.tidalItem.volumeNumber ?? 1) - 1;
		const trackNumber = (this.tidalItem.trackNumber ?? 1) - 1;

		let brainzItem = albumRelease?.media?.[volumeNumber]?.tracks?.[trackNumber];
		// If this is not the english version of the release try to find the english version of the release track
		if (albumRelease?.["text-representation"].language !== "eng" && brainzItem?.recording !== undefined) {
			return (await releaseTrackFromRecording(brainzItem.recording)) ?? brainzItem;
		}
		return brainzItem;
	});
	public brainzId: () => Promise<string | undefined> = memoize(async () => {
		const brainzItem = await this.brainzItem();
		return brainzItem?.recording.id;
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
		if (this.tidalItem.isrc) {
			yield this.tidalItem.isrc;
			seen.add(this.tidalItem.isrc);
		}

		const brainzItem = await this.brainzItem();
		if (brainzItem?.recording.isrcs) {
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

	public lyrics: () => Promise<redux.Lyrics | undefined> = memoize(() => TidalApi.lyrics(this.id));

	public title: () => Promise<string> = memoize(async () => {
		const brainzItem = await this.brainzItem();
		return ContentBase.formatTitle(this.tidalItem.title, this.tidalItem.version ?? undefined, brainzItem?.title, brainzItem?.["artist-credit"]);
	});

	public releaseDate: () => Promise<Date | undefined> = memoize(async () => {
		let releaseDate = parseDate(this.tidalItem.releaseDate) ?? parseDate(this.tidalItem.streamStartDate);
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
		return releaseDate;
	});

	/**
	 * "year-month-day"
	 */
	public releaseDateStr: () => Promise<string | undefined> = memoize(async () => {
		return (await this.releaseDate())?.toISOString().slice(0, 10);
	});

	public coverUrl: (res?: TImageSize) => Promise<string | undefined> = memoize(async (res) => {
		if (this.tidalItem.album?.cover) return ContentBase.formatCoverUrl(this.tidalItem.album?.cover, res);
		const album = await this.album();
		return album?.coverUrl(res);
	});

	public flacTags: () => Promise<MetaTags> = memoize(() => makeTags(this));

	public async copyright(): Promise<string | undefined> {
		if (!!this.tidalItem.copyright) await this.fetchTidalMediaItem();
		return this.tidalItem.copyright ?? undefined;
	}
	public async bpm(): Promise<number | undefined> {
		if (!!this.tidalItem.bpm) await this.fetchTidalMediaItem();
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
		return Quality.fromMetaTags(this.tidalItem.mediaMetadata?.tags);
	}
	public get bestQuality(): Quality {
		if (this.contentType !== "track") {
			this.trace.warn("MediaItem quality called on non-track!", this);
			return Quality.High;
		}
		return Quality.max(
			...Quality.fromMetaTags(this.tidalItem.mediaMetadata?.tags),
			Quality.fromAudioQuality(this.tidalItem.audioQuality) ?? Quality.Lowest,
		);
	}
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
	public async playbackInfo(audioQuality?: redux.AudioQuality): Promise<PlaybackInfo> {
		audioQuality ??= Quality.Max.audioQuality;
		const playbackInfo = await getPlaybackInfo(this.id, audioQuality);
		const [_, emitFormat] = this.formatEmitters[audioQuality] ?? [];
		this.cache.format ??= {};
		this.cache.format[audioQuality] = {
			...this.cache.format[audioQuality],
			bitDepth: playbackInfo.bitDepth,
			sampleRate: playbackInfo.sampleRate,
		};
		emitFormat?.(this.cache.format[audioQuality]!, this.trace.err.withContext("playbackInfo.emitFormat"));
		return playbackInfo;
	}
	// #endregion

	// #region Download
	public async downloadProgress() {
		return downloadProgress(this.id);
	}
	public async download(path: string): Promise<void> {
		const [playbackInfo, flagTags] = await Promise.all([this.playbackInfo(), this.flacTags()]);
		return download(playbackInfo, path, flagTags);
	}
	public async fileExtension(): Promise<string> {
		const playbackInfo = await this.playbackInfo();
		switch (playbackInfo.manifestMimeType) {
			case "application/dash+xml":
				return "m4a";
			case "application/vnd.tidal.bts":
				return "flac";
		}
	}
	// #endregion

	// #region Format
	private readonly formatEmitters: { [K in redux.AudioQuality]?: [onEvent: AddReceiver<MediaFormat>, emitEvent: Emit<MediaFormat>] } = {};
	public withFormat(unloads: LunaUnloads, audioQuality: redux.AudioQuality, listener: (format: MediaFormat) => void): LunaUnload {
		const [onFormat] = (this.formatEmitters[audioQuality] ??= registerEmitter<MediaFormat>());
		const unload = onFormat(unloads, listener);
		if (this.cache.format?.[audioQuality] === undefined) this.updateFormat(audioQuality);
		else listener(this.cache.format[audioQuality]);
		return unload;
	}
	private static readonly formatSema = new Semaphore(1);
	public updateFormat: (audioQuality?: redux.AudioQuality) => Promise<void> = asyncDebounce((audioQuality) =>
		MediaItem.formatSema.with(async () => {
			const playbackInfo = await this.playbackInfo(audioQuality);

			this.cache.format ??= {};
			const format = (this.cache.format[playbackInfo.audioQuality] ??= {});

			format.duration = this.duration;

			if (format.bitDepth === undefined || format.sampleRate === undefined || format.duration === undefined) {
				const { format: streamFormat, bytes } = await parseStreamFormat(playbackInfo);
				format.bytes = bytes;
				format.bitDepth = streamFormat.bitsPerSample ?? format.bitDepth;
				format.sampleRate = streamFormat.sampleRate ?? format.sampleRate;
				format.duration = streamFormat.duration ?? format.duration;
				format.codec = streamFormat.codec?.toLowerCase() ?? format.codec;
				if (playbackInfo.manifestMimeType === "application/dash+xml") {
					format.bitrate = playbackInfo.manifest.tracks.audios[0].bitrate.bps ?? format.bitrate;
					format.bytes = playbackInfo.manifest.tracks.audios[0].size?.b ?? format.bytes;
				}
			} else {
				format.bytes = (await getStreamBytes(playbackInfo)) ?? format.bytes;
			}

			format.bitrate ??= !!format.bytes && !!format.duration ? (format.bytes / format.duration) * 8 : undefined;

			const [_, emitFormat] = this.formatEmitters[playbackInfo.audioQuality] ?? [];
			emitFormat?.(format, this.trace.err.withContext("updateFormat.emitFormat"));
		}),
	);
	// #endregion
}
