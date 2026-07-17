import { asyncDebounce } from "@inrixia/helpers";

import type { Tracer } from "@luna/core";

import { libTrace } from "../index.safe";
import { ContentBase } from "./ContentBase";
import type { MediaCollection } from "./MediaCollection";
import { MediaItem } from "./MediaItem";
import { TidalApi } from "./TidalApi";

import * as redux from "../redux";

export class Playlist extends ContentBase implements MediaCollection {
	public readonly trace: Tracer;
	constructor(
		public readonly uuid: redux.ItemId,
		public readonly tidalPlaylist: redux.Playlist,
	) {
		super();
		this.trace = libTrace.withSource(`.Playlist[${tidalPlaylist.title ?? uuid}]`).trace;
	}

	public static async fromId(playlistUUID?: redux.ItemId) {
		if (playlistUUID === undefined) return;
		return super.fromStore(playlistUUID, "playlists", async (playlist) => {
			playlist = playlist ??= await TidalApi.playlist(playlistUUID);
			if (playlist === undefined) return;
			return new Playlist(playlistUUID, playlist);
		});
	}

	public async count() {
		return this.tidalPlaylist.numberOfTracks!;
	}
	/**
	 * Equivilent to `TidalApi.playlistItems`
	 */
	public tMediaItems: () => Promise<redux.MediaItem[]> = asyncDebounce(async () => {
		const playlistIitems = await TidalApi.playlistItems(this.uuid);
		return playlistIitems?.items ?? [];
	});
	public async mediaItems() {
		return MediaItem.fromTMediaItems(await this.tMediaItems());
	}

	public async title() {
		return this.tidalPlaylist.title;
	}
}
