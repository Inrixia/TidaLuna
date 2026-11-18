import { asyncDebounce } from "@inrixia/helpers";

import type { Tracer } from "@luna/core";

import { addNotificationButton } from "../helpers/notificationButton";
import { trackTableProps, trackTableRows } from "../helpers/trackTable";
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
	 * @param items Entries with their `meta.itemId`, e.g. from TIDAL's selection of a playlist table
	 * @returns Groups of the removed entries that `restoreItems` puts back where they were
	 * Waits for earlier changes to this playlist through `removeItems`/`restoreItems` to finish first.
	 * @throws If a request fails. When some of the entries were removed already, the error has those in `removed`
	 */
	public removeItems(items: TApiPlaylistItemRef[]): Promise<RemovedItems> {
		return this.change(() => this._removeItems(items));
	}
	private async _removeItems(items: TApiPlaylistItemRef[]): Promise<RemovedItems> {
		if (items.length === 0) return [];
		const order = await this.itemOrder(items);
		const done: TApiPlaylistItemRef[] = [];
		try {
			for (let i = 0; i < items.length; i += TidalApi.maxPlaylistItemsPerRequest) {
				const batch = items.slice(i, i + TidalApi.maxPlaylistItemsPerRequest);
				await TidalApi.removePlaylistItems(this.uuid, batch);
				for (const { meta } of batch) removedItemIds.add(meta.itemId);
				done.push(...batch);
			}
		} catch (err) {
			if (done.length === 0) throw err;
			throw Object.assign(
				new Error(`Removed only ${done.length} of ${items.length} items: ${err instanceof Error ? err.message : err}`, { cause: err }),
				{
					removed: groupRemoved(order, done),
				},
			);
		} finally {
			if (done.length > 0) this.refresh();
		}
		return groupRemoved(order, done);
	}
	/**
	 * Add entries removed by `removeItems` back to their places, or at the end if the entry they were before is gone too.
	 * They are new entries, so their "date added" is now. Groups that were added are taken out of `removed`,
	 * so if this fails part way it can be called again with the same array.
	 * Waits for earlier changes to this playlist through `removeItems`/`restoreItems` to finish first.
	 */
	public restoreItems(removed: RemovedItems): Promise<void> {
		return this.change(() => this._restoreItems(removed));
	}
	private async _restoreItems(removed: RemovedItems) {
		try {
			while (removed.length > 0) {
				const { items } = removed[0];
				// The entry they were before may have been put back by an earlier undo, as a new entry
				const before = currentItemId(removed[0].before);
				const added = await TidalApi.addPlaylistItems(this.uuid, items, before).catch((err: { status?: number }) => {
					// Rejected (nothing added), most likely because the entry they were before is gone, so add them at the end
					if (before === undefined || err.status === undefined || err.status < 400 || err.status >= 500) throw err;
					return TidalApi.addPlaylistItems(this.uuid, items);
				});
				// The new entries come back in order, minus any the API skipped (e.g. a track no longer on TIDAL)
				let next = 0;
				for (const { id, type, meta } of items)
					if (added[next]?.id === id && added[next].type === type) restoredItemIds.set(meta.itemId, added[next++].meta.itemId);
				removed.shift();
			}
		} finally {
			this.refresh();
		}
	}
	/**
	 * Run changes to this playlist one at a time, so each one reads the order the previous one left.
	 * Shared by all `Playlist` objects of the same playlist.
	 */
	private change<T>(fn: () => Promise<T>): Promise<T> {
		const run = (changeQueues.get(this.uuid) ?? Promise.resolve()).catch(() => {}).then(fn);
		changeQueues.set(this.uuid, run);
		// Don't keep the finished change and its result around
		const forget = () => changeQueues.get(this.uuid) === run && changeQueues.delete(this.uuid);
		run.then(forget, forget);
		return run;
	}
	// Same refresh TIDAL does after its own changes to a playlist
	private refresh() {
		lastChange.set(this.uuid, Date.now());
		redux.store.dispatch({ type: "etag/REMOVE_PLAYLIST_ETAG", payload: { playlistId: this.uuid } });
		redux.store.dispatch({ type: "content/INVALIDATE_TRACK_LIST", payload: { key: `playlists/${this.uuid}` } });
		redux.store.dispatch({ type: "tidalOpenPlatformApi/invalidateTags", payload: ["playlists"] });
	}
	// The itemIds of the playlist in playlist order, at least up to the entry after the last of `items`
	private async itemOrder(items: TApiPlaylistItemRef[]): Promise<string[]> {
		const itemIds = new Set(items.map(({ meta }) => meta.itemId));
		// TIDAL's cached list will do if it holds all the entries and the one after the last of them, or is the whole playlist
		const cached = cachedItemRefs(this.uuid);
		const cachedIds = cached?.items.map(({ meta }) => meta.itemId) ?? [];
		const covers =
			cachedIds.filter((itemId) => itemIds.has(itemId)).length === itemIds.size && (cached!.complete || !itemIds.has(cachedIds.at(-1)!));
		// Otherwise get the order of the whole playlist, one request
		return covers ? cachedIds : TidalApi.playlistItemIds(this.uuid);
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
			const count = countItems(removal.removed);
			await playlist.restoreItems(removal.removed);
			if (this.lastRemoval === removal) this.lastRemoval = undefined;
			playlist.trace.msg.log(`Restored ${itemsText(count)}`);
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
		// Still removing the previous selection, swallow the key rather than remove anything twice
		if (this.removing) return;
		this.removing = true;

		return (async () => {
			let removed: RemovedItems;
			let error: unknown;
			try {
				removed = await playlist.removeItems(selected);
			} catch (err) {
				// Part may have been removed before the error, that part can still be undone
				removed = (<{ removed?: RemovedItems }>err).removed ?? [];
				error = err;
			}
			const count = countItems(removed);
			if (count > 0) {
				// Clear the removed entries' selection like TIDAL does on its own removal. Only if the selection is still the
				// removed one: a selection made while this ran stays, and on a failure the user can try again
				const current = getPlaylistSelection();
				const currentIds = current?.getSelectedPlaylistItems().map(({ meta }) => meta.itemId) ?? [];
				const selectedIds = new Set(selected.map(({ meta }) => meta.itemId));
				if (error === undefined && currentIds.length === selectedIds.size && currentIds.every((itemId) => selectedIds.has(itemId)))
					current!.clearSelection?.();

				const removal: Removal = { uuid, removed, restoring: false };
				Playlist.lastRemoval = removal;
				const message = `Removed ${itemsText(count)}`;
				// The notification's Undo restores this removal, wherever the user is by then
				addNotificationButton(message, "Undo", () => Playlist.undo(removal).catch(playlist.trace.msg.err.withContext("Undo")));
				playlist.trace.msg.log(message);
			}
			if (error !== undefined) throw error;
		})().finally(() => (this.removing = false));
	}
	private static removing = false;

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
const countItems = (removed: RemovedItems) => removed.reduce((sum, { items }) => sum + items.length, 0);
const itemsText = (count: number) => `${count} ${count === 1 ? "item" : "items"}`;
// The running and queued changes of each playlist, see `Playlist.change`
const changeQueues = new Map<redux.ItemId, Promise<unknown>>();
// When each playlist was last changed here, TIDAL's lists of it fetched before then are out of date
const lastChange = new Map<redux.ItemId, number>();
// Entries removed in this session, TIDAL's selection can still hold them until it has reloaded the list
const removedItemIds = new Set<string>();
// The new itemId of each entry put back by `restoreItems`, by its itemId before it was removed
const restoredItemIds = new Map<string, string>();
const currentItemId = (itemId?: string) => {
	while (itemId !== undefined && restoredItemIds.has(itemId)) itemId = restoredItemIds.get(itemId);
	return itemId;
};
/**
 * Group the entries by the entry that follows them in playlist `order`, so they can be added back before it,
 * at most `TidalApi.maxPlaylistItemsPerRequest` per group
 */
const groupRemoved = (order: string[], items: TApiPlaylistItemRef[]): RemovedItems => {
	const byItemId = new Map(items.map((item) => [item.meta.itemId, item]));
	const groups: { items: TApiPlaylistItemRef[]; before?: string }[] = [];
	let group: TApiPlaylistItemRef[] = [];
	for (const itemId of order) {
		const item = byItemId.get(itemId);
		if (item !== undefined) group.push(item);
		else if (group.length > 0) {
			groups.push({ items: group, before: itemId });
			group = [];
		}
	}
	// Entries the order doesn't have go back at the end rather than not at all
	const inOrder = new Set(order);
	group.push(...items.filter(({ meta }) => !inOrder.has(meta.itemId)));
	if (group.length > 0) groups.push({ items: group });
	// Batches with the same `before` go back in order, each before the same entry
	const max = TidalApi.maxPlaylistItemsPerRequest;
	return groups.flatMap(({ items, before }) =>
		Array.from({ length: Math.ceil(items.length / max) }, (_, i) => ({ items: items.slice(i * max, (i + 1) * max), before })),
	);
};

type PlaylistSelection = { getSelectedPlaylistItems: () => TApiPlaylistItemRef[]; clearSelection?: () => void };
/**
 * The selection of the open playlist page's track table, `undefined` if there is none. Read from the first row rendered.
 */
const getPlaylistSelection = (): PlaylistSelection | undefined => {
	const row = trackTableRows(`[data-test="playlist-page"]`)[0];
	if (row === undefined) return undefined;
	const selection = trackTableProps<PlaylistSelection>(row, "getSelectedPlaylistItems");
	if (selection === undefined) libTrace.warn("Couldn't find TIDAL's playlist selection, the playlist page may have changed");
	return selection;
};

type ItemsQuery = {
	endpointName?: string;
	originalArgs?: { id?: string; sort?: string[] };
	status?: string;
	startedTimeStamp?: number;
	data?: { pages?: { data: TApiPlaylistItemRef[]; links?: { next?: string } }[] };
};
/**
 * The playlist entries TIDAL has loaded in playlist order, `complete` if that is the whole playlist.
 * `undefined` if it has none or it was fetched before the last change made here.
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
	// While it is being fetched again, e.g. right after a change, it still holds the old pages
	if (query?.status !== "fulfilled") return undefined;
	if ((query.startedTimeStamp ?? 0) < (lastChange.get(uuid) ?? 0)) return undefined;
	const pages = query.data?.pages;
	if (pages === undefined) return undefined;
	const items = pages.flatMap((page) => page.data);
	const lastLinks = pages.at(-1)?.links;
	return { items, complete: lastLinks !== undefined && lastLinks.next === undefined };
};
