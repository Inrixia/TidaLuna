import { asyncDebounce } from "@inrixia/helpers";

import type { Tracer } from "@luna/core";

import { addNotificationButton } from "../helpers/notificationButton";
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
	 * @returns Groups of the removed entries that `restoreItems` puts back where they were
	 */
	public async removeItems(items: TApiPlaylistItemRef[]): Promise<RemovedItems> {
		if (items.length === 0) return [];
		const removed = await this.removedItems(items);
		await TidalApi.removePlaylistItems(this.uuid, items);
		for (const { meta } of items) removedItemIds.add(meta.itemId);
		this.refresh();
		return removed;
	}
	/**
	 * Add entries removed by `removeItems` back to their places, or at the end if the entry they were before is gone too.
	 * They are new entries, so their "date added" is now. Groups that were added are taken out of `removed`,
	 * so if this fails part way it can be called again with the same array.
	 */
	public async restoreItems(removed: RemovedItems) {
		try {
			while (removed.length > 0) {
				const { items, before } = removed[0];
				await TidalApi.addPlaylistItems(this.uuid, items, before).catch((err: { status?: number }) => {
					// Rejected (nothing added), most likely because the entry they were before is gone, so add them at the end
					if (before === undefined || err.status === undefined || err.status < 400 || err.status >= 500) throw err;
					return TidalApi.addPlaylistItems(this.uuid, items);
				});
				removed.shift();
			}
		} finally {
			this.refresh();
		}
	}
	// Same refresh TIDAL does after its own changes to a playlist
	private refresh() {
		redux.store.dispatch({ type: "etag/REMOVE_PLAYLIST_ETAG", payload: { playlistId: this.uuid } });
		redux.store.dispatch({ type: "content/INVALIDATE_TRACK_LIST", payload: { key: `playlists/${this.uuid}` } });
		redux.store.dispatch({ type: "tidalOpenPlatformApi/invalidateTags", payload: ["playlists"] });
	}
	// Group the entries by the entry that follows them in playlist order, so they can be added back before it
	private async removedItems(items: TApiPlaylistItemRef[]): Promise<RemovedItems> {
		const itemIds = new Set(items.map(({ meta }) => meta.itemId));
		// The list must hold all the entries and the one after the last of them, unless it is the whole playlist
		const covers = (list: TApiPlaylistItemRef[], complete = false) => {
			const found = list.filter(({ meta }) => itemIds.has(meta.itemId)).length;
			return found === itemIds.size && (complete || !itemIds.has(list.at(-1)!.meta.itemId));
		};
		const cached = cachedItemRefs(this.uuid);
		let list = cached?.items;
		if (cached === undefined || !covers(cached.items, cached.complete)) list = await TidalApi.playlistItemRefs(this.uuid, { until: covers });

		const removed: RemovedItems = [];
		let group: TApiPlaylistItemRef[] = [];
		for (const item of list!) {
			if (itemIds.has(item.meta.itemId)) group.push(item);
			else if (group.length > 0) {
				removed.push({ items: group, before: item.meta.itemId });
				group = [];
			}
		}
		if (group.length > 0) removed.push({ items: group });
		return removed;
	}

	/** The last removal by `removeSelected`, for `undoRemove` */
	private static lastRemoval?: Removal;
	/**
	 * Put back the tracks/videos last removed by `removeSelected`, if their playlist is open.
	 * @returns `false` if there is nothing to undo here
	 */
	public static undoRemove() {
		const last = this.lastRemoval;
		if (last === undefined || last.restoring || last.uuid !== Playlist.currentUUID) return false;
		return this.undo(last);
	}
	private static async undo(removal: Removal) {
		if (removal.restoring || removal.removed.length === 0) return;
		removal.restoring = true;
		try {
			const playlist = await Playlist.fromId(removal.uuid);
			if (playlist === undefined) throw new Error(`Playlist ${removal.uuid} not found`);
			const count = removal.removed.reduce((sum, { items }) => sum + items.length, 0);
			await playlist.restoreItems(removal.removed);
			if (this.lastRemoval === removal) this.lastRemoval = undefined;
			playlist.trace.msg.log(`Restored ${count} ${count === 1 ? "item" : "items"}`);
		} finally {
			removal.restoring = false;
		}
	}

	/**
	 * Remove the tracks/videos selected on the open playlist page, if the user can edit the playlist.
	 * The selection is TIDAL's own, the same its "Remove from playlist" uses, so it is exact for duplicates, sorted or
	 * filtered views and rows scrolled out of view.
	 * @returns `false` if there is nothing to remove here
	 */
	public static removeSelected() {
		const uuid = Playlist.currentUUID;
		if (uuid === undefined) return false;
		const tidalPlaylist = this.getItemFromStore("playlists", uuid);
		if (tidalPlaylist === undefined) return false;
		const playlist = new Playlist(uuid, tidalPlaylist);
		if (!playlist.canEdit) return false;

		const selection = getPlaylistSelection();
		// Entries removed a moment ago can still be selected until TIDAL has reloaded the list
		const selected = selection?.getSelectedPlaylistItems().filter(({ meta }) => !removedItemIds.has(meta.itemId));
		if (selected === undefined || selected.length === 0) return false;

		return (async () => {
			const removal: Removal = { uuid, removed: await playlist.removeItems(selected), restoring: false };
			// Like TIDAL after its own removal, otherwise the selection would cover the rows that moved up
			selection!.clearSelection?.();
			Playlist.lastRemoval = removal;
			const message = `Removed ${selected.length} ${selected.length === 1 ? "item" : "items"}`;
			// The notification's Undo restores this removal, wherever the user is by then
			addNotificationButton(message, "Undo", () => Playlist.undo(removal).catch(playlist.trace.msg.err.withContext("Undo")));
			playlist.trace.msg.log(message);
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

/** Removed playlist entries grouped by the entry they were before, `before` is unset for entries that were at the end */
export type RemovedItems = { items: TApiPlaylistItemRef[]; before?: string }[];
type Removal = { uuid: redux.ItemId; removed: RemovedItems; restoring: boolean };
// Entries removed in this session, TIDAL's cached lists that still hold one of them are out of date
const removedItemIds = new Set<string>();

type PlaylistSelection = { getSelectedPlaylistItems: () => TApiPlaylistItemRef[]; clearSelection?: () => void };
/**
 * The selection of the open playlist page's track table, `undefined` if there is none. TIDAL keeps it in the table's
 * React state and passes these getters down to every row, so they are read from the first row rendered.
 */
const getPlaylistSelection = (): PlaylistSelection | undefined => {
	const row = [...document.querySelectorAll(`[data-test="playlist-page"] [data-test="tracklist-row"]`)].find(
		(row) => row.closest(`[data-test="media-table-suggested-items"]`) === null,
	);
	if (row === undefined) return undefined;
	type Fiber = { memoizedProps?: Partial<PlaylistSelection>; return?: Fiber };
	const fiberKey = Object.keys(row).find((key) => key.startsWith("__reactFiber$"));
	let fiber = fiberKey && (<Record<string, Fiber | undefined>>(<unknown>row))[fiberKey];
	for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return) {
		const props = fiber.memoizedProps;
		if (typeof props?.getSelectedPlaylistItems === "function") return <PlaylistSelection>props;
	}
	libTrace.warn("Couldn't find TIDAL's playlist selection, the playlist page may have changed");
};

type ItemsQuery = {
	endpointName?: string;
	originalArgs?: { id?: string; sort?: string[] };
	data?: { pages?: { data: TApiPlaylistItemRef[]; links?: { next?: string } }[] };
};
/**
 * The playlist entries TIDAL has loaded in playlist order, `complete` if that is the whole playlist.
 * `undefined` if it has none or its copy is out of date.
 */
const cachedItemRefs = (uuid: redux.ItemId) => {
	const queries = (<{ tidalOpenPlatformApi?: { queries?: Record<string, ItemsQuery | undefined> } }>redux.store.getState()).tidalOpenPlatformApi
		?.queries;
	const query = Object.values(queries ?? {}).find(
		(query) =>
			query?.endpointName === "getPlaylistsByIdRelationshipsItemsInfinite" &&
			query.originalArgs?.id === uuid &&
			(query.originalArgs.sort?.length ?? 0) === 0,
	);
	const pages = query?.data?.pages;
	if (pages === undefined) return undefined;
	const items = pages.flatMap((page) => page.data);
	if (items.some(({ meta }) => removedItemIds.has(meta.itemId))) return undefined;
	const lastLinks = pages.at(-1)?.links;
	return { items, complete: lastLinks !== undefined && lastLinks.next === undefined };
};
