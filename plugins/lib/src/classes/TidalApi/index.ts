import { type Tracer } from "@luna/core";

import { memoize, memoizeArgless, sleep, statusOK, type Memoized, type VoidLike } from "@inrixia/helpers";

import type { TApiTrackWithLyrics } from "./types/Lyrics";
import type { TApiTrack, TApiTracks } from "./types/Tracks";

import { getCredentials } from "../../helpers";
import { libTrace } from "../../index.safe";
import * as redux from "../../redux";

import type { AlbumPage } from "./types/AlbumPage";
import { PlaybackInfoResponse } from "./types/PlaybackInfo";

export type * from "./types";
export type { PlaybackInfoResponse };

export class TidalApi {
	public static trace: Tracer = libTrace.withSource("TidalApi").trace;
	private static unavailableTracks = new Set<redux.ItemId>();

	public static async getAuthHeaders() {
		const { clientId, token } = await getCredentials();
		return {
			Authorization: `Bearer ${token}`,
			"x-tidal-token": clientId,
		};
	}
	public static readonly queryArgs: Memoized<() => string> = memoizeArgless(() => {
		const store = redux.store.getState();
		return `countryCode=${store.session.countryCode}&deviceType=DESKTOP&locale=${store.settings.language}`;
	});
	public static fetch = memoize(async <T>(url: string): Promise<T | undefined> => {
		// Retry a failed request once with a 1s delay
		let retry = true;
		while (true) {
			const res = await fetch(url, {
				headers: await this.getAuthHeaders(),
			});
			if (statusOK(res.status)) return res.json();
			if (res.status === 403 || res.status === 404) return undefined;
			if (!retry) this.trace.err.withContext(url).throw(`${res.status} ${res.statusText}`);
			retry = false;
			await sleep(1000);
		}
	});

	public static async track(trackId: redux.ItemId) {
		return this.fetch<redux.Track>(`https://desktop.tidal.com/v1/tracks/${trackId}?${this.queryArgs()}`);
	}

	// Lock to two concurrent requests, the playing track skips ahead of queued ones (eg tracklist rows)
	private static playbackInfoSlots = 2;
	private static readonly playbackInfoQueue: { trackId: redux.ItemId; start: () => void }[] = [];
	private static async obtainPlaybackInfoSlot(trackId: redux.ItemId) {
		if (this.playbackInfoSlots > 0) this.playbackInfoSlots--;
		else await new Promise<void>((start) => this.playbackInfoQueue.push({ trackId, start }));
		return () => {
			const playingId = redux.store.getState().playbackControls.playbackContext?.actualProductId;
			const playingIndex = this.playbackInfoQueue.findIndex((queued) => String(queued.trackId) === String(playingId));
			const next = this.playbackInfoQueue.splice(Math.max(playingIndex, 0), 1)[0];
			// Hand the slot over to the next request, or free it
			if (next !== undefined) next.start();
			else this.playbackInfoSlots++;
		};
	}
	public static async playbackInfo(trackId: redux.ItemId, audioQuality: redux.AudioQuality) {
		if (this.unavailableTracks.has(trackId)) return undefined;
		const release = await this.obtainPlaybackInfoSlot(trackId);
		try {
			const result = await this.fetch<PlaybackInfoResponse>(
				`https://desktop.tidal.com/v1/tracks/${trackId}/playbackinfo?audioquality=${audioQuality}&playbackmode=STREAM&assetpresentation=FULL`,
			);
			if (result === undefined) this.unavailableTracks.add(trackId);
			return result;
		} finally {
			release();
		}
	}

	public static async lyrics(trackId: redux.ItemId): Promise<redux.Lyrics | undefined> {
		const lyrics = await this.fetch<redux.Lyrics>(`https://desktop.tidal.com/v1/tracks/${trackId}/lyrics?${this.queryArgs()}`);
		// The v1 API has no lyrics for uploaded tracks, the OpenAPI does (#168)
		return lyrics ?? this.openApiLyrics(trackId);
	}
	/** Lyrics from the OpenAPI, in the shape of the v1 API's lyrics */
	private static async openApiLyrics(trackId: redux.ItemId): Promise<redux.Lyrics | undefined> {
		const resp = await this.fetch<TApiTrackWithLyrics>(`https://openapi.tidal.com/v2/tracks/${trackId}?${this.queryArgs()}&include=lyrics`).catch(
			() => undefined,
		);
		const lyrics = resp?.included?.find((item) => item.type === "lyrics")?.attributes;
		if (!lyrics?.text) return undefined;
		return {
			trackId,
			lyricsProvider: lyrics.provider?.name ?? lyrics.provider?.source ?? "",
			providerCommontrackId: lyrics.provider?.commonTrackId ?? "",
			providerLyricsId: lyrics.provider?.lyricsId ?? "",
			lyrics: lyrics.text,
			subtitles: lyrics.lrcText || null,
			isRightToLeft: lyrics.direction === "RIGHT_TO_LEFT",
		};
	}
	public static async artist(artistId: redux.ItemId) {
		return this.fetch<redux.Artist>(`https://desktop.tidal.com/v1/artists/${artistId}?${this.queryArgs()}`);
	}

	public static async album(albumId: redux.ItemId) {
		return this.fetch<redux.Album>(`https://desktop.tidal.com/v1/albums/${albumId}?${this.queryArgs()}`);
	}
	public static async albumItems(albumId: redux.ItemId) {
		const albumPage = await this.fetch<AlbumPage>(
			`https://desktop.tidal.com/v1/pages/album?albumId=${albumId}&countryCode=NZ&locale=en_US&deviceType=DESKTOP`,
		);
		for (const row of albumPage?.rows ?? []) {
			for (const module of row.modules) {
				if (module.type === "ALBUM_ITEMS" && module.pagedList) {
					return module.pagedList.items;
				}
			}
		}
	}

	public static playlist(playlistUUID: redux.ItemId) {
		return this.fetch<redux.Playlist>(`https://desktop.tidal.com/v1/playlists/${playlistUUID}?${this.queryArgs()}`);
	}
	public static async playlistItems(playlistUUID: redux.ItemId) {
		return this.fetch<{ items: redux.MediaItem[]; totalNumberOfItems: number; offset: number; limit: -1 }>(
			`https://desktop.tidal.com/v1/playlists/${playlistUUID}/items?${this.queryArgs()}&limit=-1`,
		);
	}

	public static async *isrc(isrc: string): AsyncIterable<TApiTrack> {
		let resp = await this.fetch<TApiTracks | VoidLike>(`https://openapi.tidal.com/v2/tracks?${this.queryArgs()}&filter[isrc]=${isrc}`);
		while (true) {
			if (resp?.data === undefined || resp.data.length === 0) break;
			yield* resp.data;
			if (resp.links.next === undefined) break;
			resp = await this.fetch<TApiTracks>(`https://openapi.tidal.com/v2/${resp.links.next}`).catch(
				this.trace.err.withContext(`Unexpected error when fetching Tidal ISRC ${isrc}`),
			);
		}
	}
}
