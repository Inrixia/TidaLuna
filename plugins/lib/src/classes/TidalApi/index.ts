import { requestCache, type Tracer } from "@luna/core";

import { memoize, memoizeArgless, Semaphore, sleep, statusOK, type Memoized, type VoidLike } from "@inrixia/helpers";
import { createAPIClient } from "@tidal-music/api";
import type { CredentialsProvider } from "@tidal-music/common";

import type { TApiLyrics } from "./types/Lyrics";
import type { TApiPlaylistItemRef } from "./types/Playlist";
import type { TApiTrack, TApiTracks } from "./types/Tracks";

import { getCredentials } from "../../helpers";
import { libTrace, unloads } from "../../index.safe";
import * as redux from "../../redux";

import type { AlbumPage } from "./types/AlbumPage";
import { PlaybackInfoResponse, VideoPlaybackInfoResponse, type VideoQuality } from "./types/PlaybackInfo";

export type * from "./types";
/** TIDAL's OpenAPI types from `@tidal-music/api`, e.g. `TApiComponents["schemas"]["Tracks_Attributes"]` */
export type { components as TApiComponents, paths as TApiPaths } from "@tidal-music/api";
export type { PlaybackInfoResponse, VideoPlaybackInfoResponse, VideoQuality };

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
	/**
	 * TIDAL's own typed client for its OpenAPI (https://openapi.tidal.com/v2) from `@tidal-music/api`, signed in as the
	 * logged in user. Paths, parameters, bodies and responses are typed from TIDAL's spec, see https://tidal-music.github.io/tidal-api-reference/
	 * @example const { data, response } = await TidalApi.openApi.GET("/tracks/{id}", { params: { path: { id }, query: { countryCode } } });
	 */
	public static readonly openApi = createAPIClient(<CredentialsProvider>{ bus: () => {}, getCredentials }, undefined, {
		// The client retries failed GETs on its own, by default up to 3 times on 429/5xx and 10 times on network errors,
		// without looking at Retry-After. Retry once after ~500ms (the client's default delay for 429/5xx) so a rate limit isn't hammered
		status: { maxRetries: 1, baseDelayMs: 500 },
		network: { maxRetries: 1, baseDelayMs: 500 },
		timeout: { maxRetries: 1, baseDelayMs: 500 },
	});
	/** The `data` of an `openApi` response, `undefined` on 403/404 like `fetch`, throws on other errors */
	private static openApiData<T>({ data, response }: { data?: T; response: Response }): T | undefined {
		if (response.ok) return data;
		if (response.status === 403 || response.status === 404) return undefined;
		return this.trace.err.withContext(response.url).throw(`${response.status} ${response.statusText}`);
	}

	public static readonly queryArgs: Memoized<() => string> = memoizeArgless(() => {
		const store = redux.store.getState();
		// The locale as TIDAL formats it (en-us > en_US) so its requests share the cache
		const [lang, region] = store.locale.currentBundleName.split("-");
		const locale = region === undefined || region === "Latn" ? lang : `${lang}_${region.toUpperCase()}`;
		return `countryCode=${store.session.countryCode}&deviceType=DESKTOP&locale=${locale}`;
	});
	static {
		requestCache.register(unloads, {
			pattern: /^https:\/\/(api|desktop)\.tidal\.com\/v1\/(tracks|videos)\/\d+\/playbackinfo\?/,
			// TIDAL requests its quality setting, plugins the quality it actually got (PlayState.playbackContext.actualAudioQuality)
			extraUrls: (url, info) => {
				const audioQuality = (<PlaybackInfoResponse | undefined>info)?.audioQuality;
				if (audioQuality === undefined) return [];
				const actual = new URL(url);
				actual.searchParams.set("audioquality", audioQuality);
				return [actual];
			},
		});
		requestCache.register(unloads, { pattern: /^https:\/\/(api|desktop)\.tidal\.com\/v1\/(tracks|albums|artists|playlists)\/[\w-]+(\/lyrics)?\?/ });
	}
	/** Cached GET of TIDAL's v1 api, shared with concurrent and matching TIDAL requests, see `requestCache` */
	public static fetch<T>(url: string): Promise<T | undefined> {
		return requestCache.get<T>(url, async () => {
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
	}

	public static async track(trackId: redux.ItemId) {
		return this.fetch<redux.Track>(`https://desktop.tidal.com/v1/tracks/${trackId}?${this.queryArgs()}`);
	}

	// Lock to two concurrent requests
	private static readonly playbackInfoSemaphore = new Semaphore(2);
	// The playing item skips ahead of queued requests (eg tracklist rows)
	private static withPlaybackInfoSlot<T>(itemId: redux.ItemId, fn: () => Promise<T>) {
		const playingId = redux.store.getState().playbackControls.playbackContext?.actualProductId;
		if (playingId !== undefined && String(playingId) === String(itemId)) return this.playbackInfoSemaphore.withFirst(fn);
		return this.playbackInfoSemaphore.with(fn);
	}
	public static async playbackInfo(trackId: redux.ItemId, audioQuality: redux.AudioQuality) {
		if (this.unavailableTracks.has(trackId)) return undefined;
		const result = await this.withPlaybackInfoSlot(trackId, () =>
			this.fetch<PlaybackInfoResponse>(
				`https://desktop.tidal.com/v1/tracks/${trackId}/playbackinfo?audioquality=${audioQuality}&playbackmode=STREAM&assetpresentation=FULL`,
			),
		);
		if (result === undefined) this.unavailableTracks.add(trackId);
		return result;
	}

	public static async videoPlaybackInfo(videoId: redux.ItemId, videoQuality: VideoQuality = "HIGH") {
		return this.withPlaybackInfoSlot(videoId, () =>
			this.fetch<VideoPlaybackInfoResponse>(
				`https://desktop.tidal.com/v1/videos/${videoId}/playbackinfo?videoquality=${videoQuality}&playbackmode=STREAM&assetpresentation=FULL`,
			),
		);
	}

	public static async lyrics(trackId: redux.ItemId): Promise<redux.Lyrics | undefined> {
		const lyrics = await this.fetch<redux.Lyrics>(`https://desktop.tidal.com/v1/tracks/${trackId}/lyrics?${this.queryArgs()}`);
		// The v1 API has no lyrics for uploaded tracks, the OpenAPI does (#168)
		return lyrics ?? this.openApiLyrics(trackId);
	}
	/** Lyrics from the OpenAPI, in the shape of the v1 API's lyrics */
	private static openApiLyrics = memoize(async (trackId: redux.ItemId): Promise<redux.Lyrics | undefined> => {
		const resp = await this.openApi
			.GET("/tracks/{id}", {
				params: { path: { id: String(trackId) }, query: { countryCode: redux.store.getState().session.countryCode, include: ["lyrics"] } },
			})
			.then((res) => this.openApiData(res))
			.catch(() => undefined);
		const lyrics = resp?.included?.find((item): item is TApiLyrics => item.type === "lyrics")?.attributes;
		if (!lyrics?.text) return undefined;
		const provider = lyrics.provider;
		return {
			trackId,
			lyricsProvider: provider?.name ?? provider?.source ?? "",
			providerCommontrackId: provider?.source === "THIRD_PARTY" ? provider.commonTrackId : "",
			providerLyricsId: provider?.source === "THIRD_PARTY" ? provider.lyricsId : "",
			lyrics: lyrics.text,
			subtitles: lyrics.lrcText || null,
			isRightToLeft: lyrics.direction === "RIGHT_TO_LEFT",
		};
	});
	public static async artist(artistId: redux.ItemId) {
		return this.fetch<redux.Artist>(`https://desktop.tidal.com/v1/artists/${artistId}?${this.queryArgs()}`);
	}

	public static async album(albumId: redux.ItemId) {
		return this.fetch<redux.Album>(`https://desktop.tidal.com/v1/albums/${albumId}?${this.queryArgs()}`);
	}
	public static async albumItems(albumId: redux.ItemId) {
		const albumPage = await this.fetch<AlbumPage>(
			`https://desktop.tidal.com/v1/pages/album?albumId=${albumId}&${this.queryArgs()}`,
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

	/**
	 * Create a playlist owned by the user, the same request TIDAL's "Create playlist" dialog makes.
	 * It is `UNLISTED` unless `accessType` is `PUBLIC`.
	 * @returns The uuid of the new playlist
	 */
	public static async createPlaylist(
		name: string,
		{ description, accessType = "UNLISTED" }: { description?: string; accessType?: "PUBLIC" | "UNLISTED" } = {},
	): Promise<string> {
		const { data, response } = await this.openApi.POST("/playlists", {
			body: { data: { type: "playlists", attributes: { name, description, accessType } } },
		});
		if (!response.ok) this.trace.err.withContext(response.url).throw(`${response.status} ${response.statusText}`);
		const uuid = data?.data.id;
		if (uuid === undefined) return this.trace.err.withContext(response.url).throw("No playlist id in the response");
		return uuid;
	}

	/** Most entries TIDAL's OpenAPI takes in one request to add or remove playlist items (`maxItems` in its spec) */
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
		const { response } = await this.openApi.DELETE("/playlists/{id}/relationships/items", {
			params: { path: { id: String(playlistUUID) } },
			body: { data: items.map(({ id, type, meta }) => ({ id, type, meta: { itemId: meta.itemId } })) },
		});
		if (!response.ok) this.trace.err.withContext(response.url).throw(`${response.status} ${response.statusText}`);
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
		const { data, response } = await this.openApi.POST("/playlists/{id}/relationships/items", {
			params: { path: { id: String(playlistUUID) } },
			body: {
				data: items.map(({ id, type }) => ({ id, type })),
				meta: positionBefore === undefined ? undefined : { onDuplicates: "ADD", positionBefore },
			},
		});
		if (!response.ok)
			this.trace.err
				.withContext(response.url)
				.throw(Object.assign(new Error(`${response.status} ${response.statusText}`), { status: response.status }));
		return (data?.data ?? []).flatMap(({ id, type, meta }) => (meta === undefined ? [] : [{ id, type, meta: { itemId: meta.itemId } }]));
	}

	/** A page of the tracks with `isrc`, the page after `cursor` or the first one */
	private static isrcPage = memoize((isrc: string, cursor: string | undefined) =>
		this.openApi
			.GET("/tracks", {
				params: { query: { countryCode: redux.store.getState().session.countryCode, "filter[isrc]": [isrc], "page[cursor]": cursor } },
			})
			.then((res) => this.openApiData(res)),
	);
	public static async *isrc(isrc: string): AsyncIterable<TApiTrack> {
		let resp: TApiTracks | VoidLike = await this.isrcPage(isrc, undefined);
		while (true) {
			if (resp?.data === undefined || resp.data.length === 0) break;
			yield* resp.data;
			const cursor = resp.links.meta?.nextCursor;
			if (cursor === undefined) break;
			resp = await this.isrcPage(isrc, cursor).catch(this.trace.err.withContext(`Unexpected error when fetching Tidal ISRC ${isrc}`));
		}
	}
}
