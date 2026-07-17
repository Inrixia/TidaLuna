import { type Tracer } from "@luna/core";

import { memoize, memoizeArgless, Semaphore, sleep, statusOK, type Memoized, type VoidLike } from "@inrixia/helpers";

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

	public static async lyrics(trackId: redux.ItemId) {
		return this.fetch<redux.Lyrics>(`https://desktop.tidal.com/v1/tracks/${trackId}/lyrics?${this.queryArgs()}`);
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
