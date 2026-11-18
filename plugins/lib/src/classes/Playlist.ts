import { asyncDebounce } from "@inrixia/helpers";

import type { Tracer } from "@luna/core";

import { libTrace } from "../index.safe";
import { ContentBase } from "./ContentBase";
import type { MediaCollection } from "./MediaCollection";
import { MediaItem } from "./MediaItem";
import { TidalApi, type TApiPlaylistItemRef } from "./TidalApi";

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
		return String(this.tidalPlaylist.creator?.id) === String(redux.store.getState().session.userId);
	}

	/**
	 * True if the logged in user can change this playlist: they created it or are one of its collaborators
	 */
	public get canEdit() {
		if (this.isOwn) return true;
		const userId = String(redux.store.getState().session.userId);
		const relationships = getPlaylistEntity(this.uuid)?.relationships;
		return [relationships?.owners, relationships?.collaborators].some((rel) => rel?.data?.some(({ id }) => id === userId) ?? false);
	}

	/**
	 * Remove entries from this playlist through TIDAL's API and refresh TIDAL's views of it.
	 * @param items Entries as returned by `TidalApi.playlistItemRefs`
	 */
	public async removeItems(items: TApiPlaylistItemRef[]) {
		if (items.length === 0) return;
		await TidalApi.removePlaylistItems(this.uuid, items);
		// Same refresh TIDAL does after its own "Remove from playlist"
		redux.store.dispatch({ type: "etag/REMOVE_PLAYLIST_ETAG", payload: { playlistId: this.uuid } });
		redux.store.dispatch({ type: "content/INVALIDATE_TRACK_LIST", payload: { key: `playlists/${this.uuid}` } });
		redux.store.dispatch({ type: "tidalOpenPlatformApi/invalidateTags", payload: ["playlists"] });
	}

	/**
	 * Remove the tracks/videos selected on the open playlist page, if the user can edit the playlist.
	 * TIDAL keeps the selection in its UI rather than in redux, so it is read from the selected rows.
	 * @returns `false` if there is nothing to remove here
	 */
	public static removeSelected() {
		const uuid = Playlist.currentUUID;
		if (uuid === undefined) return false;
		const tidalPlaylist = this.getItemFromStore("playlists", uuid);
		if (tidalPlaylist === undefined) return false;
		const playlist = new Playlist(uuid, tidalPlaylist);
		if (!playlist.canEdit) return false;

		const rows = [...document.querySelectorAll<HTMLElement>(`[data-test="tracklist-row"][class*="_tableRowSelected"]`)].filter(
			(row) => row.closest(`[data-test="media-table-suggested-items"]`) === null,
		);
		if (rows.length === 0) return false;

		return (async () => {
			const wanted = rows.map((row) => ({ trackId: row.dataset.trackId, index: Number(row.dataset.index) }));
			// The entries at the rows' positions, if they hold the rows' tracks
			const atRows = (items: TApiPlaylistItemRef[]) => {
				const picked = wanted.map(({ trackId, index }) => (items[index]?.id === trackId ? items[index] : undefined));
				return picked.every((item) => item !== undefined) ? picked : undefined;
			};

			// Rows are numbered by their position in the list TIDAL shows (filtering keeps the positions), so take the entries
			// at those positions from TIDAL's cached copy of that list, or fetch the list sorted the same way
			const sort = viewSort(uuid);
			let selected: TApiPlaylistItemRef[] | undefined;
			if (sort !== undefined) {
				selected = atRows(cachedItemRefs(uuid, sort) ?? []);
				const count = Math.max(...wanted.map(({ index }) => index)) + 1;
				selected ??= atRows(await TidalApi.playlistItemRefs(uuid, { sort: sort ?? undefined, count }));
			}
			// Unknown sort order or the list changed, find the tracks by id instead
			if (selected === undefined) {
				const items = await TidalApi.playlistItemRefs(uuid);
				selected = [];
				for (const { trackId } of wanted) {
					const copies = items.filter(({ id }) => id === trackId);
					if (copies.length > 1)
						return playlist.trace.msg.warn(
							"This track is in the playlist more than once, so it is unclear which copy to remove. Sort by playlist order and try again.",
						);
					selected.push(...copies);
				}
			}
			if (selected.length === 0) return playlist.trace.msg.warn("The selected tracks were not found in the playlist, reload it and try again.");
			await playlist.removeItems(selected);
			playlist.trace.msg.log(`Removed ${selected.length} ${selected.length === 1 ? "item" : "items"}`);
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

type PlaylistEntity = { relationships?: Partial<Record<"owners" | "collaborators", { data?: { id: string }[] }>> };
// TIDAL's openapi playlist data, it lists the owners and collaborators
const getPlaylistEntity = (uuid: redux.ItemId) =>
	(<{ entities?: { playlists?: { entities?: Record<string, PlaylistEntity> } } }>redux.store.getState()).entities?.playlists?.entities?.[uuid];

// The OpenAPI sort field TIDAL fetches each sorted playlist view with
const sortFields: Partial<Record<redux.SortOrder, string>> = {
	NAME: "title",
	ARTIST: "artists.name",
	ALBUM: "albums.title",
	DATE: "addedAt",
	LENGTH: "duration",
};
/**
 * The OpenAPI sort of the playlist list TIDAL is showing, `null` in playlist order, `undefined` if unknown.
 * The sorted column header is checked too, in case the table and redux disagree.
 */
const viewSort = (uuid: redux.ItemId): string | null | undefined => {
	const { currentOrder, currentDirection } = redux.store.getState().content.trackLists[`playlists/${uuid}`] ?? {};
	const headerSorted =
		document.querySelector(`[role="columnheader"][aria-sort="ascending"], [role="columnheader"][aria-sort="descending"]`) !== null;
	if ((currentOrder ?? "INDEX") === "INDEX") return headerSorted || currentDirection === "DESC" ? undefined : null;
	const field = sortFields[currentOrder!];
	if (field === undefined || !headerSorted) return undefined;
	return currentDirection === "DESC" ? `-${field}` : field;
};

type ItemsQuery = {
	endpointName?: string;
	originalArgs?: { id?: string; sort?: string[] };
	data?: { pages?: { data: TApiPlaylistItemRef[] }[] };
};
/** The playlist entries TIDAL has loaded for the list sorted by `sort`, `undefined` if it has none */
const cachedItemRefs = (uuid: redux.ItemId, sort: string | null) => {
	const queries = (<{ tidalOpenPlatformApi?: { queries?: Record<string, ItemsQuery | undefined> } }>redux.store.getState()).tidalOpenPlatformApi
		?.queries;
	const query = Object.values(queries ?? {}).find(
		(query) =>
			query?.endpointName === "getPlaylistsByIdRelationshipsItemsInfinite" &&
			query.originalArgs?.id === uuid &&
			(query.originalArgs.sort?.join(",") ?? null) === sort,
	);
	return query?.data?.pages?.flatMap((page) => page.data);
};
