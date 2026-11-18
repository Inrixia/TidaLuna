import { asyncDebounce } from "@inrixia/helpers";

import type { LunaUnload, Tracer } from "@luna/core";

import { observePromise } from "../helpers/observable";
import { libTrace } from "../index.safe";
import { ContentBase } from "./ContentBase";
import type { MediaCollection } from "./MediaCollection";
import { MediaItem } from "./MediaItem";
import { StyleTag } from "./StyleTag";
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

	/**
	 * UUID of the playlist whose page is currently open, `undefined` on any other page
	 */
	public static get currentUUID(): redux.ItemId | undefined {
		return /^\/playlist\/([^/?#]+)/.exec(redux.store.getState().router.currentPath)?.[1];
	}

	/**
	 * True if the logged in user created this playlist
	 */
	public get isOwn() {
		return this.tidalPlaylist.creator?.id === redux.store.getState().session.userId;
	}

	/**
	 * Remove the tracks/videos selected on the open playlist page, if it is the user's own playlist.
	 * TIDAL keeps the selection in its UI rather than in redux, so this runs TIDAL's own "Remove from playlist" from the selected rows' context menu,
	 * which also takes care of sorting, filtering and duplicate tracks.
	 * @returns `false` if there is nothing to remove here
	 */
	public static removeSelected() {
		const uuid = Playlist.currentUUID;
		if (uuid === undefined) return false;
		const tidalPlaylist = this.getItemFromStore("playlists", uuid);
		if (tidalPlaylist === undefined || !new Playlist(uuid, tidalPlaylist).isOwn) return false;

		const row = [...document.querySelectorAll<HTMLElement>(`[data-test="tracklist-row"][class*="_tableRowSelected"]`)].find(
			(row) => row.closest(`[data-test="media-table-suggested-items"]`) === null,
		);
		if (row === undefined) return false;

		return (async () => {
			// Hide the context menu while it's opened just to click remove
			const hideMenu = new Set<LunaUnload>();
			new StyleTag("luna-hide-context-menu", hideMenu, `[data-type="list-container__context-menu"] { visibility: hidden; }`);
			try {
				const { x, y, width, height } = row.getBoundingClientRect();
				row.dispatchEvent(
					new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: x + width / 2, clientY: y + height / 2 }),
				);
				const remove = await observePromise<HTMLElement>(hideMenu, `[data-test="contextmenu-delete"]`, 1000);
				if (remove !== null) remove.click();
				else redux.actions["contextMenu/CLOSE"]();
			} finally {
				for (const unload of hideMenu) unload();
			}
		})();
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
