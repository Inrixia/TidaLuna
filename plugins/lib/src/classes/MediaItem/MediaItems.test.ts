import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resetTidalState, setTidalState, type TidalState } from "../../../../../test/harness/tidalStore";

import type { MediaItem } from "./MediaItem";
import { MediaItem as MediaItemClass } from "./MediaItem";
import { MediaItems } from "./MediaItems";

type Fiber = {
	memoizedProps?: Record<string, unknown>;
	return?: Fiber | null;
	tag?: number;
	stateNode?: { current?: Fiber };
};

/** A fiber chain ending in the current root render, which is what `trackTableProps` checks for */
const currentChain = (fibers: Omit<Fiber, "return">[]): Fiber => {
	const root: Fiber = { tag: 3 };
	root.stateNode = { current: root };
	let parent = root;
	for (const fiber of fibers) {
		const node: Fiber = { ...fiber, return: parent };
		parent = node;
	}
	return parent;
};

let fiberCount = 0;
/** A tracklist row as TIDAL's React tree leaves it: the fiber hangs off a `__reactFiber$<random>` key */
const rowWith = (fiber: Fiber, parent: Element = document.body) => {
	const row = document.createElement("div");
	row.setAttribute("data-test", "tracklist-row");
	(<Record<string, unknown>>(<unknown>row))[`__reactFiber$${fiberCount++}`] = fiber;
	parent.append(row);
	return row;
};

/** A row whose table passes down a `getSelectedMediaItemIds` getter, like TIDAL's track table does */
const rowWhoseTableHasSelection = (getSelectedMediaItemIds: () => number[]) =>
	rowWith(currentChain([{ memoizedProps: { getSelectedMediaItemIds } }]));

const setMediaItemTypes = (mediaItems: Record<string, { type?: string }>) =>
	setTidalState({ content: { mediaItems } } as unknown as Partial<TidalState>);

const fakeMediaItem = (title: string) => ({ tidalItem: { title } }) as unknown as MediaItem;

beforeEach(() => {
	resetTidalState();
	document.body.innerHTML = "";
});

afterEach(() => {
	vi.restoreAllMocks();
	resetTidalState();
	document.body.innerHTML = "";
});

describe("fromIds", () => {
	test("wraps each id as a track", () => {
		const mediaItems = MediaItems.fromIds([101, "102"]);

		expect(mediaItems.tMediaItems).toEqual([
			{ item: { id: 101 }, type: "track" },
			{ item: { id: "102" }, type: "track" },
		]);
	});

	test("uses the content type it is given for every id", () => {
		expect(MediaItems.fromIds([103], "video").tMediaItems).toEqual([{ item: { id: 103 }, type: "video" }]);
	});

	test("an empty list of ids is an empty collection", async () => {
		const mediaItems = MediaItems.fromIds([]);

		expect(mediaItems.tMediaItems).toEqual([]);
		await expect(mediaItems.count()).resolves.toBe(0);
	});
});

describe("fromTMediaItems", () => {
	test("wraps the items as given", () => {
		const items = [
			{ item: { id: 104 }, type: "video" as const },
			{ item: { id: 105 }, type: "track" as const },
		];

		const mediaItems = MediaItems.fromTMediaItems(items);

		expect(mediaItems.tMediaItems).toBe(items);
	});

	test("count() is the number of items it holds", async () => {
		await expect(MediaItems.fromTMediaItems([{ item: { id: 106 }, type: "track" }]).count()).resolves.toBe(1);
	});
});

describe("mediaItems", () => {
	test("yields the items TIDAL's media item loader yields with the items it holds", async () => {
		const fromTMediaItems = vi.spyOn(MediaItemClass, "fromTMediaItems");
		const first = fakeMediaItem("First");
		const second = fakeMediaItem("Second");
		fromTMediaItems.mockImplementation(() =>
			(async function* () {
				yield* [first, second];
			})(),
		);
		const mediaItems = MediaItems.fromTMediaItems([{ item: { id: 107 }, type: "track" }]);

		const yielded: MediaItem[] = [];
		for await (const mediaItem of await mediaItems.mediaItems()) yielded.push(mediaItem);

		expect(yielded).toEqual([first, second]);
		expect(fromTMediaItems).toHaveBeenCalledWith([{ item: { id: 107 }, type: "track" }]);
	});
});

describe("title", () => {
	test("is the title of the first item", async () => {
		vi.spyOn(MediaItemClass, "fromTMediaItems").mockImplementation(() =>
			(async function* () {
				yield fakeMediaItem("First");
				yield fakeMediaItem("Second");
			})(),
		);

		await expect(MediaItems.fromIds([108, 109]).title()).resolves.toBe("First");
	});

	test("is undefined without items", async () => {
		vi.spyOn(MediaItemClass, "fromTMediaItems").mockImplementation(() => (async function* () {})());

		await expect(MediaItems.fromIds([]).title()).resolves.toBeUndefined();
	});
});

describe("fromSelection", () => {
	test("returns the selected ids, with the type TIDAL stored each item with", () => {
		setMediaItemTypes({ 201: { type: "video" }, 202: { type: "track" } });
		rowWhoseTableHasSelection(() => [201, 202]);

		const mediaItems = MediaItems.fromSelection();

		expect(mediaItems?.tMediaItems).toEqual([
			{ item: { id: 201 }, type: "video" },
			{ item: { id: 202 }, type: "track" },
		]);
	});

	test("an id TIDAL has no media item for is a track", () => {
		rowWhoseTableHasSelection(() => [203]);

		expect(MediaItems.fromSelection()?.tMediaItems).toEqual([{ item: { id: 203 }, type: "track" }]);
	});

	test("is undefined when the table has no selection", () => {
		rowWhoseTableHasSelection(() => []);

		expect(MediaItems.fromSelection()).toBeUndefined();
	});

	test("is undefined without a track table", () => {
		expect(MediaItems.fromSelection()).toBeUndefined();
	});

	test("is undefined for rows that have no selection getter", () => {
		rowWith(currentChain([{ memoizedProps: {} }]));

		expect(MediaItems.fromSelection()).toBeUndefined();
	});

	test("asks each table once", () => {
		// The first table's getter is passed down to two of its rows, and it has nothing selected
		const emptyGetter = vi.fn(() => []);
		rowWhoseTableHasSelection(emptyGetter);
		rowWhoseTableHasSelection(emptyGetter);
		const selectedGetter = vi.fn(() => [204]);
		rowWhoseTableHasSelection(selectedGetter);

		expect(MediaItems.fromSelection()?.tMediaItems).toEqual([{ item: { id: 204 }, type: "track" }]);
		expect(emptyGetter).toHaveBeenCalledTimes(1);
		expect(selectedGetter).toHaveBeenCalledTimes(1);
	});

	test("takes the first table that has a selection", () => {
		rowWhoseTableHasSelection(() => []);
		rowWhoseTableHasSelection(() => [205]);
		rowWhoseTableHasSelection(() => [206]);

		expect(MediaItems.fromSelection()?.tMediaItems).toEqual([{ item: { id: 205 }, type: "track" }]);
	});

	test("leaves out the rows of suggested tracks under a playlist", () => {
		const suggested = document.createElement("div");
		suggested.setAttribute("data-test", "media-table-suggested-items");
		document.body.append(suggested);
		rowWith(currentChain([{ memoizedProps: { getSelectedMediaItemIds: () => [207] } }]), suggested);

		expect(MediaItems.fromSelection()).toBeUndefined();
	});
});
