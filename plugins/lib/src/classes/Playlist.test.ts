import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { reduxStore, resetTidalState, SET_STATE, setTidalState } from "test/harness/tidalStore";

import type * as redux from "../redux";
import { Playlist, type RemovedItems } from "./Playlist";
import { TidalApi, type TApiPlaylistItemRef } from "./TidalApi";

/**
 * What `removeItems`/`restoreItems` do is mostly visible in the requests they make and the actions they dispatch, so
 * those are what these tests assert on: `TidalApi`'s calls are stubbed with `vi.spyOn` and dispatches are recorded.
 *
 * `Playlist.ts` keeps state between calls (the queue of changes to each playlist, when each playlist was last changed,
 * the new itemIds `restoreItems` gave entries) and `ContentBase` caches instances by uuid. Every test therefore uses
 * its own uuid and itemIds, so nothing leaks into another test.
 */

/** An entry of a playlist, `meta.itemId` is what identifies it in the playlist */
const entry = (itemId: string, type: "tracks" | "videos" = "tracks"): TApiPlaylistItemRef => ({
	id: `track-${itemId}`,
	type,
	meta: { itemId },
});
/** An entry as `addPlaylistItems` returns it: the added track with the new `meta.itemId` TIDAL gave it */
const addedEntry = (itemId: string, newItemId: string, type: "tracks" | "videos" = "tracks"): TApiPlaylistItemRef => ({
	id: `track-${itemId}`,
	type,
	meta: { itemId: newItemId },
});
const itemIds = (items: TApiPlaylistItemRef[]) => items.map(({ meta }) => meta.itemId);

const tidalPlaylist = (fields: Partial<redux.Playlist> = {}): redux.Playlist =>
	({
		uuid: "playlist",
		title: "A Playlist",
		creator: { id: 1 },
		numberOfTracks: 0,
		squareImage: "",
		image: "",
		...fields,
	}) as redux.Playlist;

const makePlaylist = (uuid: string, fields?: Partial<redux.Playlist>) => new Playlist(uuid, tidalPlaylist({ uuid, ...fields }));

type CachedItemsOpts = { status?: string; startedTimeStamp?: number; sort?: string[]; lastLinks?: { next?: string } };
/** An items query of a playlist as TIDAL's cached `tidalOpenPlatformApi` holds it, `lastLinks` set means more pages */
const cachedItemsQuery = (
	uuid: string,
	pages: TApiPlaylistItemRef[][],
	{
		status = "fulfilled",
		startedTimeStamp = Date.now() + 60_000,
		sort = [],
		lastLinks = {} as { next?: string } | undefined,
	}: CachedItemsOpts = {},
) => ({
	endpointName: "getPlaylistsByIdRelationshipsItemsInfinite",
	originalArgs: { id: uuid, sort },
	status,
	startedTimeStamp,
	data: { pages: pages.map((data, i) => ({ data, links: i === pages.length - 1 ? lastLinks : { next: "next-page" } })) },
});
const useCachedItems = (uuid: string, pages: TApiPlaylistItemRef[][], opts?: CachedItemsOpts) =>
	setTidalState({ tidalOpenPlatformApi: { queries: { "items-infinite": cachedItemsQuery(uuid, pages, opts) } } });

type DispatchedAction = { type?: string; payload?: unknown };
/** Records the actions the code dispatched from now on, without the harness' own state patches */
const recordActions = () => {
	const dispatched: DispatchedAction[] = [];
	const storeDispatch = reduxStore.dispatch.bind(reduxStore);
	vi.spyOn(reduxStore, "dispatch").mockImplementation((action: DispatchedAction) => {
		if (action.type !== SET_STATE) dispatched.push(action);
		return storeDispatch(action as never);
	});
	return dispatched;
};
/** The three invalidations TIDAL makes after its own changes to a playlist, which `refresh` copies */
const expectRefresh = (dispatched: DispatchedAction[], uuid: string) => {
	expect(dispatched).toEqual([
		{ type: "etag/REMOVE_PLAYLIST_ETAG", payload: { playlistId: uuid } },
		{ type: "content/INVALIDATE_TRACK_LIST", payload: { key: `playlists/${uuid}` } },
		{ type: "tidalOpenPlatformApi/invalidateTags", payload: ["playlists"] },
	]);
};

beforeEach(() => {
	vi.restoreAllMocks();
	resetTidalState();
});
afterEach(() => {
	vi.restoreAllMocks();
	resetTidalState();
});

describe("fromId", () => {
	test("has no playlist without an id", async () => {
		expect(await Playlist.fromId()).toBeUndefined();
	});

	test("uses the playlist TIDAL's store already has", async () => {
		const uuid = "pl-fromid-store";
		setTidalState({ content: { playlists: { [uuid]: tidalPlaylist({ uuid, title: "In the store" }) } } });
		const api = vi.spyOn(TidalApi, "playlist");

		const playlist = await Playlist.fromId(uuid);

		expect(api).not.toHaveBeenCalled();
		expect(playlist?.uuid).toBe(uuid);
		expect(await playlist?.title()).toBe("In the store");
	});

	test("fetches the playlist when TIDAL's store doesn't have it", async () => {
		const uuid = "pl-fromid-fetch";
		setTidalState({ content: { playlists: {} } });
		const api = vi.spyOn(TidalApi, "playlist").mockResolvedValue(tidalPlaylist({ uuid, title: "Fetched" }));

		const playlist = await Playlist.fromId(uuid);

		expect(api).toHaveBeenCalledWith(uuid);
		expect(playlist).toBeInstanceOf(Playlist);
		expect(await playlist?.title()).toBe("Fetched");
	});

	test("has no playlist when TIDAL doesn't have it either", async () => {
		setTidalState({ content: { playlists: {} } });
		vi.spyOn(TidalApi, "playlist").mockResolvedValue(undefined);

		expect(await Playlist.fromId("pl-fromid-missing")).toBeUndefined();
	});

	test("returns the same instance for the same id", async () => {
		const uuid = "pl-fromid-cached";
		setTidalState({ content: { playlists: {} } });
		const api = vi.spyOn(TidalApi, "playlist").mockResolvedValue(tidalPlaylist({ uuid }));

		const first = await Playlist.fromId(uuid);
		const second = await Playlist.fromId(uuid);

		expect(first).toBeInstanceOf(Playlist);
		expect(second).toBe(first);
		expect(api).toHaveBeenCalledTimes(1);
	});
});

describe("create", () => {
	test("creates the playlist, adds the items and returns it", async () => {
		const uuid = "pl-created";
		setTidalState({ content: { playlists: {} } });
		const createPlaylist = vi.spyOn(TidalApi, "createPlaylist").mockResolvedValue(uuid);
		const add = vi.spyOn(TidalApi, "addPlaylistItems").mockResolvedValue([]);
		vi.spyOn(TidalApi, "playlist").mockResolvedValue(tidalPlaylist({ uuid, title: "New Playlist" }));
		const dispatched = recordActions();

		const playlist = await Playlist.create("New Playlist", {
			description: "From Luna",
			accessType: "PUBLIC",
			mediaItems: [
				{ id: 111, contentType: "track" },
				{ id: 222, contentType: "video" },
			],
		});

		expect(createPlaylist).toHaveBeenCalledWith("New Playlist", { description: "From Luna", accessType: "PUBLIC" });
		expect(add).toHaveBeenCalledTimes(1);
		expect(add.mock.calls[0]).toEqual([
			uuid,
			[
				{ id: "111", type: "tracks" },
				{ id: "222", type: "videos" },
			],
		]);
		expect(playlist).toBeInstanceOf(Playlist);
		expect(await playlist?.title()).toBe("New Playlist");
		// TIDAL shows a new playlist in its lists right away
		expect(dispatched).toEqual([{ type: "folders/LOAD_FOLDER_ITEMS", payload: { context: "page", reset: true } }]);
	});

	test("adds the items in batches of the max", async () => {
		const uuid = "pl-created-batches";
		setTidalState({ content: { playlists: {} } });
		vi.spyOn(TidalApi, "createPlaylist").mockResolvedValue(uuid);
		const add = vi.spyOn(TidalApi, "addPlaylistItems").mockResolvedValue([]);
		vi.spyOn(TidalApi, "playlist").mockResolvedValue(tidalPlaylist({ uuid }));
		const max = TidalApi.maxPlaylistItemsPerRequest;
		const mediaItems = Array.from({ length: max + 1 }, (_, i) => ({ id: i + 1, contentType: "track" as const }));

		await Playlist.create("Batches", { mediaItems });

		expect(add).toHaveBeenCalledTimes(2);
		expect(add.mock.calls[0][1]).toHaveLength(max);
		expect(add.mock.calls[1][1]).toEqual([{ id: String(max + 1), type: "tracks" }]);
	});

	test("asks TIDAL to add no items when there are none", async () => {
		const uuid = "pl-created-empty";
		setTidalState({ content: { playlists: {} } });
		vi.spyOn(TidalApi, "createPlaylist").mockResolvedValue(uuid);
		const add = vi.spyOn(TidalApi, "addPlaylistItems").mockResolvedValue([]);
		vi.spyOn(TidalApi, "playlist").mockResolvedValue(tidalPlaylist({ uuid }));

		await Playlist.create("Empty");

		// `chunkArray([])` gives one empty chunk, so one add request with no items is still made
		expect(add.mock.calls).toEqual([[uuid, []]]);
	});

	test("shows the new playlist in TIDAL's lists even when adding its items fails", async () => {
		const uuid = "pl-created-add-failed";
		setTidalState({ content: { playlists: {} } });
		vi.spyOn(TidalApi, "createPlaylist").mockResolvedValue(uuid);
		vi.spyOn(TidalApi, "addPlaylistItems").mockRejectedValue(new Error("500 Internal Server Error"));
		const api = vi.spyOn(TidalApi, "playlist");
		const dispatched = recordActions();

		await expect(Playlist.create("Doomed", { mediaItems: [{ id: 1, contentType: "track" }] })).rejects.toThrow("500 Internal Server Error");

		// The playlist exists, so TIDAL has to list it even though the items couldn't be added
		expect(dispatched).toEqual([{ type: "folders/LOAD_FOLDER_ITEMS", payload: { context: "page", reset: true } }]);
		expect(api).not.toHaveBeenCalled();
	});

	test("throws without touching TIDAL's lists when it can't create the playlist", async () => {
		vi.spyOn(TidalApi, "createPlaylist").mockRejectedValue(new Error("403 Forbidden"));
		const add = vi.spyOn(TidalApi, "addPlaylistItems");
		const dispatched = recordActions();

		await expect(Playlist.create("Nope")).rejects.toThrow("403 Forbidden");

		expect(add).not.toHaveBeenCalled();
		expect(dispatched).toEqual([]);
	});
});

describe("removeItems", () => {
	test("does nothing for no items", async () => {
		const playlist = makePlaylist("pl-remove-none");
		const order = vi.spyOn(TidalApi, "playlistItemIds");
		const remove = vi.spyOn(TidalApi, "removePlaylistItems");
		const dispatched = recordActions();

		expect(await playlist.removeItems([])).toEqual([]);

		expect(order).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(dispatched).toEqual([]);
	});

	test("removes in batches of the max and refreshes once", async () => {
		const uuid = "pl-remove-batches";
		const playlist = makePlaylist(uuid);
		const max = TidalApi.maxPlaylistItemsPerRequest;
		const items = Array.from({ length: max + 1 }, (_, i) => entry(`entry-${i}`));
		vi.spyOn(TidalApi, "playlistItemIds").mockResolvedValue(itemIds(items));
		const remove = vi.spyOn(TidalApi, "removePlaylistItems").mockResolvedValue(undefined);
		const dispatched = recordActions();

		await playlist.removeItems(items);

		expect(remove).toHaveBeenCalledTimes(2);
		expect(remove.mock.calls[0]).toEqual([uuid, items.slice(0, max)]);
		expect(remove.mock.calls[1]).toEqual([uuid, [items[max]]]);
		expectRefresh(dispatched, uuid);
	});

	test("throws an error holding what it did remove when a batch fails", async () => {
		const uuid = "pl-remove-partial";
		const playlist = makePlaylist(uuid);
		const max = TidalApi.maxPlaylistItemsPerRequest;
		const items = Array.from({ length: max + 1 }, (_, i) => entry(`entry-${i}`));
		vi.spyOn(TidalApi, "playlistItemIds").mockResolvedValue(itemIds(items));
		const cause = new Error("503 Service Unavailable");
		const remove = vi.spyOn(TidalApi, "removePlaylistItems").mockResolvedValueOnce(undefined).mockRejectedValueOnce(cause);
		const dispatched = recordActions();

		const err = await playlist.removeItems(items).catch((err) => err);

		expect(remove).toHaveBeenCalledTimes(2);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe(`Removed only ${max} of ${max + 1} items: ${cause.message}`);
		expect(err.cause).toBe(cause);
		// The removed entries are grouped so they can be put back before the entry that followed them
		expect(err.removed).toEqual([{ items: items.slice(0, max), before: items[max].meta.itemId }]);
		expectRefresh(dispatched, uuid);
	});

	test("rethrows the first error untouched when nothing was removed", async () => {
		const playlist = makePlaylist("pl-remove-failed");
		const items = [entry("entry-a"), entry("entry-b")];
		vi.spyOn(TidalApi, "playlistItemIds").mockResolvedValue(itemIds(items));
		const cause = new Error("418 I'm a teapot");
		vi.spyOn(TidalApi, "removePlaylistItems").mockRejectedValue(cause);
		const dispatched = recordActions();

		await expect(playlist.removeItems(items)).rejects.toBe(cause);

		// Nothing changed, so TIDAL's views of the playlist are left alone
		expect(dispatched).toEqual([]);
	});

	test("throws without removing anything when the order can't be fetched", async () => {
		const playlist = makePlaylist("pl-remove-no-order");
		const cause = new Error("504 Gateway Timeout");
		vi.spyOn(TidalApi, "playlistItemIds").mockRejectedValue(cause);
		const remove = vi.spyOn(TidalApi, "removePlaylistItems");
		const dispatched = recordActions();

		await expect(playlist.removeItems([entry("entry-a")])).rejects.toBe(cause);

		expect(remove).not.toHaveBeenCalled();
		expect(dispatched).toEqual([]);
	});
});

describe("removeItems grouping", () => {
	/** Remove `items` from a playlist whose order the API answers with, and return the groups */
	const removeFromOrder = async (uuid: string, order: TApiPlaylistItemRef[], items: TApiPlaylistItemRef[]) => {
		const playlist = makePlaylist(uuid);
		vi.spyOn(TidalApi, "playlistItemIds").mockResolvedValue(itemIds(order));
		vi.spyOn(TidalApi, "removePlaylistItems").mockResolvedValue(undefined);
		return playlist.removeItems(items);
	};

	test("entries removed next to each other share a group", async () => {
		const order = ["entry-a", "entry-b", "entry-c", "entry-d"].map((itemId) => entry(itemId));

		const groups = await removeFromOrder("pl-groups-adjacent", order, [order[1], order[2]]);

		expect(groups).toEqual([{ items: [order[1], order[2]], before: "entry-d" }]);
	});

	test("entries removed apart become separate groups", async () => {
		const order = ["entry-a", "entry-b", "entry-c", "entry-d", "entry-e"].map((itemId) => entry(itemId));

		const groups = await removeFromOrder("pl-groups-apart", order, [order[1], order[3]]);

		expect(groups).toEqual([
			{ items: [order[1]], before: "entry-c" },
			{ items: [order[3]], before: "entry-e" },
		]);
	});

	test("entries removed from the end of the playlist have no entry to go back before", async () => {
		const order = ["entry-a", "entry-b", "entry-c"].map((itemId) => entry(itemId));

		const groups = await removeFromOrder("pl-groups-end", order, [order[1], order[2]]);

		expect(groups).toEqual([{ items: [order[1], order[2]], before: undefined }]);
	});

	test("entries the order doesn't have go back at the end rather than not at all", async () => {
		const order = ["entry-a", "entry-b"].map((itemId) => entry(itemId));
		const notInOrder = entry("entry-gone");

		const groups = await removeFromOrder("pl-groups-unknown", order, [order[0], notInOrder]);

		expect(groups).toEqual([{ items: [order[0]], before: "entry-b" }, { items: [notInOrder] }]);
	});

	test("chunks a group at the max, each chunk before the same entry", async () => {
		const max = TidalApi.maxPlaylistItemsPerRequest;
		const removed = Array.from({ length: max + 1 }, (_, i) => entry(`entry-${i}`));
		const after = entry("entry-after");

		const groups = await removeFromOrder("pl-groups-chunked", [...removed, after], removed);

		expect(groups).toEqual([
			{ items: removed.slice(0, max), before: "entry-after" },
			{ items: [removed[max]], before: "entry-after" },
		]);
	});
});

describe("itemOrder", () => {
	test("uses TIDAL's cached items when they hold every entry and are the whole playlist", async () => {
		const uuid = "pl-order-cached-complete";
		const playlist = makePlaylist(uuid);
		const cached = [entry("entry-a"), entry("entry-b"), entry("entry-z")];
		useCachedItems(uuid, [cached.slice(0, 2), [cached[2]]]);
		const order = vi.spyOn(TidalApi, "playlistItemIds");
		vi.spyOn(TidalApi, "removePlaylistItems").mockResolvedValue(undefined);

		const groups = await playlist.removeItems([cached[0], cached[1]]);

		expect(order).not.toHaveBeenCalled();
		expect(groups).toEqual([{ items: [cached[0], cached[1]], before: "entry-z" }]);
	});

	test("uses a cached page that ends on the entry after the last one removed", async () => {
		const uuid = "pl-order-cached-partial";
		const playlist = makePlaylist(uuid);
		const cached = [entry("entry-a"), entry("entry-b")];
		useCachedItems(uuid, [cached], { lastLinks: { next: "page-2" } });
		const order = vi.spyOn(TidalApi, "playlistItemIds");
		vi.spyOn(TidalApi, "removePlaylistItems").mockResolvedValue(undefined);

		const groups = await playlist.removeItems([cached[0]]);

		expect(order).not.toHaveBeenCalled();
		expect(groups).toEqual([{ items: [cached[0]], before: "entry-b" }]);
	});

	test("asks the api when the cache is missing one of the entries", async () => {
		const uuid = "pl-order-cached-missing";
		const playlist = makePlaylist(uuid);
		const cached = [entry("entry-a"), entry("entry-b")];
		useCachedItems(uuid, [cached]);
		const order = vi.spyOn(TidalApi, "playlistItemIds").mockResolvedValue(["entry-a", "entry-c", "entry-z"]);
		vi.spyOn(TidalApi, "removePlaylistItems").mockResolvedValue(undefined);

		const groups = await playlist.removeItems([cached[0], entry("entry-c")]);

		expect(order).toHaveBeenCalledWith(uuid);
		expect(groups).toEqual([{ items: [cached[0], entry("entry-c")], before: "entry-z" }]);
	});

	test("asks the api when a partial cache ends on one of the entries being removed", async () => {
		const uuid = "pl-order-cached-ends-on-target";
		const playlist = makePlaylist(uuid);
		const cached = [entry("entry-a"), entry("entry-b")];
		useCachedItems(uuid, [cached], { lastLinks: { next: "page-2" } });
		const order = vi.spyOn(TidalApi, "playlistItemIds").mockResolvedValue(["entry-a", "entry-b", "entry-z"]);
		vi.spyOn(TidalApi, "removePlaylistItems").mockResolvedValue(undefined);

		const groups = await playlist.removeItems(cached);

		expect(order).toHaveBeenCalledWith(uuid);
		expect(groups).toEqual([{ items: cached, before: "entry-z" }]);
	});

	test("asks the api while the cached items are being fetched again", async () => {
		const uuid = "pl-order-cached-pending";
		const playlist = makePlaylist(uuid);
		const cached = [entry("entry-a")];
		useCachedItems(uuid, [cached], { status: "pending" });
		const order = vi.spyOn(TidalApi, "playlistItemIds").mockResolvedValue(["entry-a"]);
		vi.spyOn(TidalApi, "removePlaylistItems").mockResolvedValue(undefined);

		await playlist.removeItems(cached);

		expect(order).toHaveBeenCalledWith(uuid);
	});

	test("asks the api for cached items fetched before the last change made here", async () => {
		const uuid = "pl-order-cached-stale";
		const playlist = makePlaylist(uuid);
		const items = [entry("entry-a")];
		const order = vi.spyOn(TidalApi, "playlistItemIds").mockResolvedValue(itemIds(items));
		vi.spyOn(TidalApi, "removePlaylistItems").mockResolvedValue(undefined);

		// The change marks when the playlist changed, TIDAL's list of it from before then is out of date
		await playlist.removeItems(items);
		useCachedItems(uuid, [items], { startedTimeStamp: Date.now() - 60_000 });

		await playlist.removeItems(items);

		expect(order).toHaveBeenCalledTimes(2);
	});

	test("asks the api for a sorted view or another playlist's cached items", async () => {
		const uuid = "pl-order-cached-other";
		const playlist = makePlaylist(uuid);
		const items = [entry("entry-a")];
		setTidalState({
			tidalOpenPlatformApi: {
				queries: {
					"another-playlist": cachedItemsQuery("pl-order-cached-someone-else", [items]),
					sorted: cachedItemsQuery(uuid, [items], { sort: ["DATE"] }),
				},
			},
		});
		const order = vi.spyOn(TidalApi, "playlistItemIds").mockResolvedValue(itemIds(items));
		vi.spyOn(TidalApi, "removePlaylistItems").mockResolvedValue(undefined);

		await playlist.removeItems(items);

		expect(order).toHaveBeenCalledWith(uuid);
	});
});

describe("restoreItems", () => {
	test("adds a group back before the entry that followed it", async () => {
		const uuid = "pl-restore-before";
		const playlist = makePlaylist(uuid);
		const items = [entry("before-b")];
		const add = vi.spyOn(TidalApi, "addPlaylistItems").mockResolvedValue([addedEntry("before-b", "before-new-b")]);
		const dispatched = recordActions();

		await playlist.restoreItems([{ items, before: "before-c" }]);

		expect(add).toHaveBeenCalledTimes(1);
		expect(add.mock.calls[0]).toEqual([uuid, items, "before-c"]);
		expectRefresh(dispatched, uuid);
	});

	test("appends when the entry it was before is gone", async () => {
		const uuid = "pl-restore-append";
		const playlist = makePlaylist(uuid);
		const items = [entry("append-b")];
		const add = vi
			.spyOn(TidalApi, "addPlaylistItems")
			.mockRejectedValueOnce(Object.assign(new Error("404 Not Found"), { status: 404 }))
			.mockResolvedValueOnce([addedEntry("append-b", "append-new-b")]);

		await playlist.restoreItems([{ items, before: "append-gone" }]);

		expect(add).toHaveBeenCalledTimes(2);
		expect(add.mock.calls[0]).toEqual([uuid, items, "append-gone"]);
		expect(add.mock.calls[1]).toEqual([uuid, items]);
	});

	test.each([
		["a 5xx", () => Object.assign(new Error("503 Service Unavailable"), { status: 503 })],
		["no status", () => new Error("socket hang up")],
	])("rethrows %s instead of appending", async (_name, makeCause) => {
		const uuid = `pl-restore-rethrow-${_name.replace(" ", "-")}`;
		const playlist = makePlaylist(uuid);
		const items = [entry("rethrow-b")];
		const cause = makeCause();
		const add = vi.spyOn(TidalApi, "addPlaylistItems").mockRejectedValueOnce(cause);
		const dispatched = recordActions();

		await expect(playlist.restoreItems([{ items, before: "rethrow-c" }])).rejects.toBe(cause);

		expect(add).toHaveBeenCalledTimes(1);
		// The playlist may have partially changed, so TIDAL's views are refreshed either way
		expectRefresh(dispatched, uuid);
	});

	test("rethrows when there is no entry to append after either", async () => {
		const playlist = makePlaylist("pl-restore-rethrow-append");
		const cause = Object.assign(new Error("404 Not Found"), { status: 404 });
		const add = vi.spyOn(TidalApi, "addPlaylistItems").mockRejectedValue(cause);

		await expect(playlist.restoreItems([{ items: [entry("tail-b")] }])).rejects.toBe(cause);

		expect(add).toHaveBeenCalledTimes(1);
	});

	test("restores every group in order, each before its entry", async () => {
		const uuid = "pl-restore-groups";
		const playlist = makePlaylist(uuid);
		const removed: RemovedItems = [
			{ items: [entry("groups-a")], before: "groups-x" },
			{ items: [entry("groups-b")] },
			{ items: [entry("groups-c")], before: "groups-y" },
		];
		const add = vi.spyOn(TidalApi, "addPlaylistItems").mockResolvedValue([]);

		await playlist.restoreItems(removed);

		// `before` is passed even when there is none, TIDAL then appends the entries
		expect(add.mock.calls).toEqual([
			[uuid, [entry("groups-a")], "groups-x"],
			[uuid, [entry("groups-b")], undefined],
			[uuid, [entry("groups-c")], "groups-y"],
		]);
		expect(removed).toEqual([]);
	});

	test("continues with the rest of the array when called again after a failure", async () => {
		const uuid = "pl-restore-retry";
		const playlist = makePlaylist(uuid);
		const removed: RemovedItems = [
			{ items: [entry("retry-a")], before: "retry-z" },
			{ items: [entry("retry-b")], before: "retry-y" },
		];
		const cause = Object.assign(new Error("503 Service Unavailable"), { status: 503 });
		const add = vi
			.spyOn(TidalApi, "addPlaylistItems")
			.mockResolvedValueOnce([addedEntry("retry-a", "retry-new-a")])
			.mockRejectedValueOnce(cause)
			.mockResolvedValueOnce([addedEntry("retry-b", "retry-new-b")]);

		await expect(playlist.restoreItems(removed)).rejects.toBe(cause);
		// The groups that were added are out of the array, so retrying it doesn't add them twice
		expect(removed).toEqual([{ items: [entry("retry-b")], before: "retry-y" }]);

		await playlist.restoreItems(removed);

		expect(removed).toEqual([]);
		expect(add.mock.calls).toEqual([
			[uuid, [entry("retry-a")], "retry-z"],
			[uuid, [entry("retry-b")], "retry-y"],
			[uuid, [entry("retry-b")], "retry-y"],
		]);
	});

	test("positions a group before the new entry an earlier restore added", async () => {
		const uuid = "pl-restore-chain";
		const playlist = makePlaylist(uuid);
		const add = vi
			.spyOn(TidalApi, "addPlaylistItems")
			// chain-b was at the end, so it came back with a new itemId
			.mockResolvedValueOnce([addedEntry("chain-b", "chain-new-b")])
			// and that new entry was removed and restored again
			.mockResolvedValueOnce([addedEntry("chain-new-b", "chain-newer-b")])
			.mockResolvedValueOnce([addedEntry("chain-a", "chain-new-a")]);

		await playlist.restoreItems([{ items: [entry("chain-b")] }]);
		await playlist.restoreItems([{ items: [entry("chain-new-b")] }]);
		// The order the caller read still names the entry chain-a was before by its first itemId
		await playlist.restoreItems([{ items: [entry("chain-a")], before: "chain-b" }]);

		expect(add.mock.calls[2]).toEqual([uuid, [entry("chain-a")], "chain-newer-b"]);
	});

	test("only tracks the new itemId of the entries the api actually added", async () => {
		const uuid = "pl-restore-skipped";
		const playlist = makePlaylist(uuid);
		const add = vi
			.spyOn(TidalApi, "addPlaylistItems")
			// skip-a was skipped, e.g. the track is no longer on TIDAL
			.mockResolvedValueOnce([addedEntry("skip-b", "skip-new-b")])
			.mockResolvedValue([]);

		await playlist.restoreItems([{ items: [entry("skip-a"), entry("skip-b")] }]);
		// skip-a was never added, so it is still known by the itemId it had
		await playlist.restoreItems([{ items: [entry("skip-c")], before: "skip-a" }]);
		expect(add.mock.calls[1]).toEqual([uuid, [entry("skip-c")], "skip-a"]);
		// skip-b was added, so it is known by the new itemId TIDAL gave it
		await playlist.restoreItems([{ items: [entry("skip-d")], before: "skip-b" }]);
		expect(add.mock.calls[2]).toEqual([uuid, [entry("skip-d")], "skip-new-b"]);
	});
});

describe("change serialisation", () => {
	test("runs changes to one playlist one at a time", async () => {
		const playlist = makePlaylist("pl-change-serial");
		const events: string[] = [];
		vi.spyOn(TidalApi, "playlistItemIds").mockImplementation(async () => {
			events.push("order");
			return [];
		});
		vi.spyOn(TidalApi, "removePlaylistItems").mockImplementation(async (_uuid, items) => {
			events.push(`remove:${items[0].meta.itemId}`);
		});

		await Promise.all([playlist.removeItems([entry("first")]), playlist.removeItems([entry("second")])]);

		// The second change read the order only after the first one finished, so it sees what it left
		expect(events).toEqual(["order", "remove:first", "order", "remove:second"]);
	});

	test("runs changes to different playlists in parallel", async () => {
		const first = makePlaylist("pl-change-parallel-a");
		const second = makePlaylist("pl-change-parallel-b");
		const events: string[] = [];
		vi.spyOn(TidalApi, "playlistItemIds").mockImplementation(async (uuid) => {
			events.push(`order:${uuid}`);
			return [];
		});
		vi.spyOn(TidalApi, "removePlaylistItems").mockImplementation(async (uuid) => {
			events.push(`remove:${uuid}`);
		});

		await Promise.all([first.removeItems([entry("entry-a")]), second.removeItems([entry("entry-b")])]);

		expect(events).toEqual([
			"order:pl-change-parallel-a",
			"order:pl-change-parallel-b",
			"remove:pl-change-parallel-a",
			"remove:pl-change-parallel-b",
		]);
	});

	test("a failed change doesn't stop the next one", async () => {
		const playlist = makePlaylist("pl-change-failure");
		const order = vi.spyOn(TidalApi, "playlistItemIds").mockRejectedValueOnce(new Error("502 Bad Gateway")).mockResolvedValue([]);
		const remove = vi.spyOn(TidalApi, "removePlaylistItems").mockResolvedValue(undefined);

		await expect(playlist.removeItems([entry("first")])).rejects.toThrow("502 Bad Gateway");
		await playlist.removeItems([entry("second")]);

		expect(order).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledTimes(1);
	});
});

describe("isOwn", () => {
	test("is true for a playlist the logged in user created", () => {
		// The session's user id is "1"
		expect(makePlaylist("pl-own", { creator: { id: 1 } }).isOwn).toBe(true);
		expect(makePlaylist("pl-own-string", { creator: { id: "1" } }).isOwn).toBe(true);
	});

	test("is false for someone else's playlist", () => {
		expect(makePlaylist("pl-own-other", { creator: { id: 2 } }).isOwn).toBe(false);
	});
});

describe("canEdit", () => {
	/** `entities.playlists.entities[uuid].relationships` as TIDAL's openapi holds it */
	const setRelationships = (uuid: string, relationships: Record<string, { data?: { id: string }[] }>) =>
		setTidalState({ entities: { playlists: { entities: { [uuid]: { relationships } } } } });

	test("is true for an own playlist", () => {
		expect(makePlaylist("pl-canedit-own", { creator: { id: 1 } }).canEdit).toBe(true);
	});

	test("is true for a collaborator", () => {
		const uuid = "pl-canedit-collaborator";
		setRelationships(uuid, { collaborators: { data: [{ id: "1" }, { id: "2" }] } });

		expect(makePlaylist(uuid, { creator: { id: 3 } }).canEdit).toBe(true);
	});

	test("is true for an owner listed on the playlist", () => {
		const uuid = "pl-canedit-owner";
		setRelationships(uuid, { owners: { data: [{ id: "1" }] } });

		expect(makePlaylist(uuid, { creator: { id: 3 } }).canEdit).toBe(true);
	});

	test("is false for someone else's playlist", () => {
		const uuid = "pl-canedit-other";
		setRelationships(uuid, { owners: { data: [{ id: "2" }] }, collaborators: { data: [{ id: "3" }] } });

		expect(makePlaylist(uuid, { creator: { id: 3 } }).canEdit).toBe(false);
	});

	test("is false without the playlist's relationships", () => {
		expect(makePlaylist("pl-canedit-none", { creator: { id: 2 } }).canEdit).toBe(false);
		setRelationships("pl-canedit-empty", {});
		expect(makePlaylist("pl-canedit-empty", { creator: { id: 2 } }).canEdit).toBe(false);
	});
});

describe("imageIds", () => {
	test("is the square image then the wide one", () => {
		expect(makePlaylist("pl-images", { squareImage: "square-uuid", image: "wide-uuid" }).imageIds).toEqual(["square-uuid", "wide-uuid"]);
	});

	test("skips missing and empty images", () => {
		expect(makePlaylist("pl-images-wide", { image: "wide-uuid" }).imageIds).toEqual(["wide-uuid"]);
		expect(makePlaylist("pl-images-square", { squareImage: "square-uuid" }).imageIds).toEqual(["square-uuid"]);
		expect(makePlaylist("pl-images-blank", { squareImage: "", image: "" }).imageIds).toEqual([]);
		expect(makePlaylist("pl-images-none").imageIds).toEqual([]);
	});
});

describe("coverUrl", () => {
	test("is the square image at 1280 by default", () => {
		const playlist = makePlaylist("pl-cover", { squareImage: "square-uuid", image: "wide-uuid" });
		expect(playlist.coverUrl()).toBe("https://resources.tidal.com/images/square/uuid/1280x1280.jpg");
	});

	test("takes the resolution option", () => {
		const playlist = makePlaylist("pl-cover-opts", { squareImage: "square-uuid", image: "wide-uuid" });
		expect(playlist.coverUrl({ res: "320" })).toBe("https://resources.tidal.com/images/square/uuid/320x320.jpg");
		expect(playlist.coverUrl({ res: "80" })).toBe("https://resources.tidal.com/images/square/uuid/80x80.jpg");
	});

	test("falls back to the wide image", () => {
		expect(makePlaylist("pl-cover-wide", { squareImage: "", image: "wide-uuid" }).coverUrl()).toBe(
			"https://resources.tidal.com/images/wide/uuid/1280x1280.jpg",
		);
	});

	test("has no url without an image", () => {
		expect(makePlaylist("pl-cover-none").coverUrl()).toBeUndefined();
	});
});

describe("currentUUID", () => {
	test("is the playlist of the open playlist page", () => {
		setTidalState({ router: { currentPath: "/playlist/uuid-1" } });
		expect(Playlist.currentUUID).toBe("uuid-1");
	});

	test("ignores what follows the uuid", () => {
		setTidalState({ router: { currentPath: "/playlist/uuid-1?utm_source=share" } });
		expect(Playlist.currentUUID).toBe("uuid-1");
	});

	test("is undefined on any other page", () => {
		setTidalState({ router: { currentPath: "/" } });
		expect(Playlist.currentUUID).toBeUndefined();
		setTidalState({ router: { currentPath: "/playlist/" } });
		expect(Playlist.currentUUID).toBeUndefined();
		setTidalState({ router: { currentPath: "/album/playlist/uuid-1" } });
		expect(Playlist.currentUUID).toBeUndefined();
	});
});

describe("count and title", () => {
	test("count is the number of tracks TIDAL reports", async () => {
		expect(await makePlaylist("pl-count", { numberOfTracks: 12 }).count()).toBe(12);
	});

	test("title is the playlist's title", async () => {
		expect(await makePlaylist("pl-title", { title: "My Playlist" }).title()).toBe("My Playlist");
	});
});
