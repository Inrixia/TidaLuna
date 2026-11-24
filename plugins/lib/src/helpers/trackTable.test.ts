import { afterEach, describe, expect, test } from "vitest";

import { trackTableProps, trackTableRows } from "./trackTable";

type Fiber = {
	memoizedProps?: Record<string, unknown>;
	return?: Fiber | null;
	alternate?: Fiber | null;
	tag?: number;
	stateNode?: { current?: Fiber };
};

/** A fiber chain ending in the current root render, which is what `isCurrent` checks for */
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

/** A row element as TIDAL's React tree leaves it: the fiber is hung off a `__reactFiber$<random>` key */
const rowWith = (fiber: Fiber): Element => {
	const row = document.createElement("div");
	(<Record<string, unknown>>(<unknown>row))["__reactFiber$abc123"] = fiber;
	return row;
};

const getter = (value: string) => ({ getSelectedMediaItemIds: () => [value] });

describe("trackTableProps", () => {
	test("reads the getter from the row's own fiber", () => {
		const row = rowWith(currentChain([{ memoizedProps: getter("1") }]));
		expect(trackTableProps<{ getSelectedMediaItemIds: () => string[] }>(row, "getSelectedMediaItemIds")?.getSelectedMediaItemIds()).toEqual(["1"]);
	});

	test("walks up to an ancestor that carries the getter", () => {
		// TIDAL passes the selection getter down from the table, not on every row
		const row = rowWith(currentChain([{ memoizedProps: { unrelated: true } }, { memoizedProps: {} }, { memoizedProps: getter("2") }]));
		expect(trackTableProps<{ getSelectedMediaItemIds: () => string[] }>(row, "getSelectedMediaItemIds")?.getSelectedMediaItemIds()).toEqual(["2"]);
	});

	test("stops looking after ten levels", () => {
		// The row fiber is the last link, so a getter this far up the tree is never reached
		const above = Array.from({ length: 11 }, () => ({ memoizedProps: {} }));
		const row = rowWith(currentChain([{ memoizedProps: getter("3") }, ...above]));
		expect(trackTableProps(row, "getSelectedMediaItemIds")).toBeUndefined();
	});

	test("returns undefined without a fiber", () => {
		expect(trackTableProps(document.createElement("div"), "getSelectedMediaItemIds")).toBeUndefined();
	});

	test("returns undefined when the getter is not a function", () => {
		const row = rowWith(currentChain([{ memoizedProps: { getSelectedMediaItemIds: "nope" } }]));
		expect(trackTableProps(row, "getSelectedMediaItemIds")).toBeUndefined();
	});

	test("uses the alternate fiber when the one the DOM points at is the previous render", () => {
		// React keeps two copies; the current one is the one leading to the root's current fiber
		const stale: Fiber = { memoizedProps: getter("stale") };
		const staleRoot: Fiber = { tag: 3 };
		staleRoot.stateNode = { current: {} as Fiber };
		const staleRow = { ...stale, return: staleRoot };

		const current: Fiber = { memoizedProps: getter("current") };
		const currentRoot: Fiber = { tag: 3 };
		currentRoot.stateNode = { current: currentRoot };
		const currentRow: Fiber = { ...current, return: currentRoot };
		// The alternate leads to the current render
		staleRow.alternate = currentRow;

		const row = rowWith(staleRow);
		expect(trackTableProps<{ getSelectedMediaItemIds: () => string[] }>(row, "getSelectedMediaItemIds")?.getSelectedMediaItemIds()).toEqual([
			"current",
		]);
	});

	test("takes the alternate's props when the fiber is not the current render, without checking that the alternate is", () => {
		// Only one isCurrent check is made: it picks which copy to read, then that copy is trusted
		const fiber: Fiber = { memoizedProps: getter("x") };
		const root: Fiber = { tag: 3 };
		root.stateNode = { current: {} as Fiber };
		fiber.return = root;
		fiber.alternate = { memoizedProps: getter("y"), return: root };

		expect(
			trackTableProps<{ getSelectedMediaItemIds: () => string[] }>(rowWith(fiber), "getSelectedMediaItemIds")?.getSelectedMediaItemIds(),
		).toEqual(["y"]);
	});

	test("returns undefined when the alternate has no getter either", () => {
		const fiber: Fiber = { memoizedProps: getter("x") };
		const root: Fiber = { tag: 3 };
		root.stateNode = { current: {} as Fiber };
		fiber.return = root;
		fiber.alternate = { memoizedProps: {}, return: root };

		expect(trackTableProps(rowWith(fiber), "getSelectedMediaItemIds")).toBeUndefined();
	});
});

describe("trackTableRows", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	const row = (parent: Element = document.body) => {
		const element = document.createElement("div");
		element.setAttribute("data-test", "tracklist-row");
		parent.append(element);
		return element;
	};

	test("returns the tracklist rows", () => {
		const first = row();
		const second = row();
		expect(trackTableRows()).toEqual([first, second]);
	});

	test("leaves out rows of suggested tracks under a playlist", () => {
		const playlistRow = row();
		const suggested = document.createElement("div");
		suggested.setAttribute("data-test", "media-table-suggested-items");
		document.body.append(suggested);
		row(suggested);

		expect(trackTableRows()).toEqual([playlistRow]);
	});

	test("honours a scope selector", () => {
		const album = document.createElement("div");
		album.setAttribute("data-test", "album-page");
		document.body.append(album);
		const albumRow = row(album);
		row();

		expect(trackTableRows(`[data-test="album-page"]`)).toEqual([albumRow]);
	});
});
