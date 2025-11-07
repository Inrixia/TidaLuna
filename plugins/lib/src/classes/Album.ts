import { memoize, type VoidLike } from "@inrixia/helpers";

import type { IRelease, IReleaseMatch } from "musicbrainz-api";

import { ftch, type Tracer } from "@luna/core";

import { libTrace } from "../index.safe";
import { Artist } from "./Artist";
import { ContentBase, type TImageSize } from "./ContentBase";
import type { MediaCollection } from "./MediaCollection";
import { MediaItem } from "./MediaItem";
import { TidalApi } from "./TidalApi";

import type * as redux from "../redux";

export class Album extends ContentBase implements MediaCollection {
	public readonly trace: Tracer;
	constructor(
		public readonly id: redux.ItemId,
		public readonly tidalAlbum: redux.Album,
	) {
		super();
		this.trace = Album.trace.withSource(`[${this.tidalAlbum.title ?? id}]`).trace;
	}

	public static readonly trace: Tracer = libTrace.withSource(".Album").trace;

	public static async fromId(albumId?: redux.ItemId): Promise<Album | undefined> {
		if (albumId === undefined) return;
		return super.fromStore(albumId, "albums", async (album) => {
			album = album ??= await TidalApi.album(albumId);
			if (album === undefined) return;
			return new Album(albumId, album);
		});
	}

	/**
	 * MusicBrainz Album from `https://musicbrainz.org/ws/2/release/?query=barcode:${this.tidalAlbum.upc}`
	 */
	public brainzAlbum: () => Promise<IReleaseMatch | VoidLike> = memoize(async () => {
		if (this.tidalAlbum.upc === undefined) return;

		const brainzUrl = `https://musicbrainz.org/ws/2/release/?query=barcode:${this.tidalAlbum.upc}&fmt=json`;
		const brainzAlbum = await ftch
			.json<{ releases: IReleaseMatch[] }>(brainzUrl)
			.then(({ releases }) => releases[0])
			.catch(this.trace.warn.withContext("getUPCReleases"));

		// @ts-expect-error musicbrainz-api lib missing types
		const trackCount: number = brainzAlbum?.["track-count"];

		const brainzTrackCount = trackCount ?? brainzAlbum?.media?.reduce((count, album) => (count += album?.["track-count"] ?? 0), 0);

		// Try validate if the album is valid because sometimes tidal has the wrong upc id!
		if (brainzTrackCount !== undefined && this.tidalAlbum.numberOfTracks === brainzTrackCount) {
			return brainzAlbum;
		}

		if (brainzAlbum !== undefined) this.trace.warn("Invalid Tidal UPC for album!", brainzAlbum, this, brainzUrl);
	});

	/**
	 * MusicBrainz Album with additional release info from `https://musicbrainz.org/ws/2/release/${this.brainzAlbum.id}?inc=recordings+isrcs+artist-credits`
	 */
	public brainzRelease: () => Promise<IRelease | VoidLike> = memoize(async () => {
		const brainzAlbum = await this.brainzAlbum();
		if (brainzAlbum === undefined) return;
		return ftch
			.json<IRelease>(`https://musicbrainz.org/ws/2/release/${brainzAlbum.id}?inc=recordings+isrcs+artist-credits&fmt=json`)
			.catch(this.trace.warn.withContext("getReleaseAlbum"));
	});

	public artist: () => Promise<Artist | undefined> = memoize(async () => {
		if (this.tidalAlbum.artist?.id) return Artist.fromId(this.tidalAlbum.artist.id);
		if (this.tidalAlbum.artists?.[0]?.id) return Artist.fromId(this.tidalAlbum.artists?.[0].id);
	});
	public artists: () => Promise<Artist | undefined>[] = memoize(() => {
		return this.tidalAlbum.artists?.map((artist) => Artist.fromId(artist.id)) ?? [];
	});

	public async count() {
		return this.tidalAlbum.numberOfTracks!;
	}
	public tMediaItems: () => Promise<redux.MediaItem[]> = memoize(async () => {
		const albumItems = await TidalApi.albumItems(this.id);
		return albumItems ?? [];
	});
	public async mediaItems() {
		return MediaItem.fromTMediaItems(await this.tMediaItems());
	}

	public coverUrl(res?: TImageSize) {
		if (this.tidalAlbum.cover === undefined) return;
		return ContentBase.formatCoverUrl(this.tidalAlbum.cover, res);
	}

	public title: () => Promise<string | undefined> = memoize(async () => {
		const brainzAlbum = await this.brainzAlbum();
		return ContentBase.formatTitle(
			this.tidalAlbum.title,
			this.tidalAlbum.version ?? undefined,
			brainzAlbum?.title,
			brainzAlbum?.["artist-credit"],
		);
	});

	public upc: () => Promise<string | undefined> = memoize(async () => {
		return this.tidalAlbum.upc ?? (await this.brainzAlbum())?.barcode;
	});

	public async brainzId(): Promise<string | undefined> {
		return (await this.brainzAlbum())?.id;
	}

	public get genre(): string | undefined {
		return this.tidalAlbum.genre ?? undefined;
	}
	public get recordLabel(): string | undefined {
		return this.tidalAlbum.recordLabel ?? undefined;
	}
	public get numberOfTracks(): number {
		return this.tidalAlbum.numberOfTracks;
	}
	public get releaseDate(): string | undefined {
		return this.tidalAlbum.releaseDate ?? this.tidalAlbum.streamStartDate;
	}
	public get releaseYear(): string | undefined {
		return this.tidalAlbum.releaseYear ?? undefined;
	}
}
