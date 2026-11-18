import { type Tracer } from "@luna/core";

import { memoize, memoizeArgless, Semaphore, sleep, statusOK, type Memoized, type VoidLike } from "@inrixia/helpers";

import type { TApiTrackWithLyrics } from "./types/Lyrics";
import type { TApiPlaylistItemRef } from "./types/Playlist";
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

	// Lock to two concurrent requests
	private static readonly playbackInfoSemaphore = new Semaphore(2);
	public static async playbackInfo(trackId: redux.ItemId, audioQuality: redux.AudioQuality) {
		if (this.unavailableTracks.has(trackId)) return undefined;
		const result = await this.playbackInfoSemaphore.with(() =>
			this.fetch<PlaybackInfoResponse>(
				`https://desktop.tidal.com/v1/tracks/${trackId}/playbackinfo?audioquality=${audioQuality}&playbackmode=STREAM&assetpresentation=FULL`,
			),
		);
		if (result === undefined) this.unavailableTracks.add(trackId);
		return result;
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

	/** Most entries the openapi takes in one request to add or remove playlist items, more is rejected */
	public static readonly maxPlaylistItemsPerRequest = 50;
	/**
	 * The `meta.itemId` of each entry of a playlist in playlist order, from a single request.
	 * Not cached, always the current state.
	 */
	public static async playlistItemIds(playlistUUID: redux.ItemId): Promise<string[]> {
		// The server caches this list by URL for a while after changes, a unique URL gets the current one
		const url = `https://desktop.tidal.com/v1/playlists/${playlistUUID}/items?${this.queryArgs()}&limit=-1&_=${Date.now()}`;
		const res = await fetch(url, { headers: await this.getAuthHeaders() });
		if (!statusOK(res.status)) this.trace.err.withContext(url).throw(`${res.status} ${res.statusText}`);
		const body: { items: { item: { itemUuid: string } }[] } = await res.json();
		return body.items.map(({ item }) => item.itemUuid);
	}
	/**
	 * Remove items from a playlist, the same request TIDAL's "Remove from playlist" makes.
	 * At most `maxPlaylistItemsPerRequest` items.
	 */
	public static async removePlaylistItems(playlistUUID: redux.ItemId, items: TApiPlaylistItemRef[]) {
		const url = `https://openapi.tidal.com/v2/playlists/${playlistUUID}/relationships/items?${this.queryArgs()}`;
		const res = await fetch(url, {
			method: "DELETE",
			headers: { ...(await this.getAuthHeaders()), "Content-Type": "application/vnd.api+json" },
			body: JSON.stringify({ data: items.map(({ id, type, meta }) => ({ id, type, meta: { itemId: meta.itemId } })) }),
		});
		if (!statusOK(res.status)) this.trace.err.withContext(url).throw(`${res.status} ${res.statusText}`);
	}

	/**
	 * Add tracks/videos to a playlist, the same request TIDAL makes. They are added in order before the entry
	 * with the `meta.itemId` `positionBefore`, or at the end. At most `maxPlaylistItemsPerRequest` items.
	 * @returns The new entries, in the order of `items`
	 * @throws An error with the response `status` if the request is rejected, nothing is added then
	 */
	public static async addPlaylistItems(
		playlistUUID: redux.ItemId,
		items: Pick<TApiPlaylistItemRef, "id" | "type">[],
		positionBefore?: string,
	): Promise<TApiPlaylistItemRef[]> {
		const url = `https://openapi.tidal.com/v2/playlists/${playlistUUID}/relationships/items?${this.queryArgs()}`;
		const res = await fetch(url, {
			method: "POST",
			headers: { ...(await this.getAuthHeaders()), "Content-Type": "application/vnd.api+json" },
			body: JSON.stringify({
				data: items.map(({ id, type }) => ({ id, type })),
				meta: positionBefore === undefined ? undefined : { positionBefore },
			}),
		});
		if (!statusOK(res.status))
			this.trace.err.withContext(url).throw(Object.assign(new Error(`${res.status} ${res.statusText}`), { status: res.status }));
		// The entries are added at this point, so an unreadable body isn't an error
		const body: { data?: TApiPlaylistItemRef[] } | undefined = await res.json().catch(() => undefined);
		return body?.data ?? [];
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
