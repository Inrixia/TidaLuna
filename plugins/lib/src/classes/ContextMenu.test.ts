import { unloadSet, type LunaUnload } from "@luna/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// TIDAL's action creators are hooked by exposeTidalInternals.patchAction: `window.patchAction` hands back builders that
// run Luna's interceptors first, which is how a context menu opening is triggered here. Side effect import.
import "../../../../render/src/exposeTidalInternals.patchAction";
import type * as redux from "../redux";
import type { Album } from "./Album";
import { ContextMenu } from "./ContextMenu";
import { MediaItems } from "./MediaItem";
import type { Playlist } from "./Playlist";

const unloads = new Set<LunaUnload>();
/** Registered buttons are private: these tests check they are added and unhooked rather than how they look */
const buttons = (ContextMenu as unknown as { buttons: Set<unknown> }).buttons;

/** TIDAL's context menu with its template item, a `div[data-type="contextmenu-item"]` holding a button and a label */
const contextMenuElem = ({ template = true } = {}) => {
	const contextMenu = document.createElement("div");
	contextMenu.setAttribute("data-type", "list-container__context-menu");
	if (template) {
		const item = document.createElement("div");
		item.setAttribute("data-type", "contextmenu-item");
		const button = document.createElement("button");
		button.setAttribute("data-test", "contextmenu-item");
		const label = document.createElement("span");
		button.append(label);
		item.append(button);
		contextMenu.append(item);
	}
	document.body.append(contextMenu);
	return contextMenu;
};
/** The items of a context menu, the first one is TIDAL's template */
const items = (contextMenu: Element) => contextMenu.querySelectorAll('div[data-type="contextmenu-item"]');

/** `build` is the patched action creator TIDAL dispatches with, so calling it runs the interceptors like TIDAL does */
const tidalAction = (type: string) => {
	const actionCreators = { _: (actionType: string) => (payload?: unknown) => ({ type: actionType, payload }) };
	(window as any).patchAction(actionCreators);
	return actionCreators._(type);
};
/** Interceptors run async, so a macrotask lets them (and the emitter) finish */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	document.body.innerHTML = "";
});
afterEach(async () => {
	await unloadSet(unloads);
	document.body.innerHTML = "";
});

describe("addButton", () => {
	test("has no element and no text until it is shown", () => {
		const before = buttons.size;
		const button = ContextMenu.addButton(unloads);

		expect(buttons.size).toBe(before + 1);
		expect(buttons.has(button)).toBe(true);
		expect(button.elem).toBeUndefined();
		expect(button.text).toBe("");
	});

	test("unloading removes the button", async () => {
		const button = ContextMenu.addButton(unloads);

		await unloadSet(unloads);

		expect(buttons.has(button)).toBe(false);
	});

	test("shows a clone of TIDAL's template item in the context menu", async () => {
		const contextMenu = contextMenuElem();
		const button = ContextMenu.addButton(unloads);

		const label = await button.show(contextMenu);

		expect(items(contextMenu)).toHaveLength(2);
		// The clone is a fresh item, without the template's `data-test`
		expect(contextMenu.querySelectorAll("button[data-test]")).toHaveLength(1);
		expect(label?.tagName).toBe("SPAN");
		expect(label?.parentElement?.parentElement?.getAttribute("data-type")).toBe("contextmenu-item");
		expect(items(contextMenu)[1]).toBe(label?.parentElement?.parentElement);
	});

	test("showing it again reuses the same item", async () => {
		const contextMenu = contextMenuElem();
		const button = ContextMenu.addButton(unloads);

		const first = await button.show(contextMenu);
		const second = await button.show(contextMenu);

		expect(second).toBe(first);
		expect(items(contextMenu)).toHaveLength(2);
	});

	test("show without a context menu does nothing", async () => {
		const button = ContextMenu.addButton(unloads);

		expect(await button.show(null)).toBeUndefined();
	});

	test("show keeps the element when there is no context menu to show it in", async () => {
		const contextMenu = contextMenuElem();
		const button = ContextMenu.addButton(unloads);

		const label = await button.show(contextMenu);

		expect(await button.show(null)).toBe(label);
	});

	test("needs TIDAL's template item to clone", async () => {
		const contextMenu = contextMenuElem({ template: false });
		const button = ContextMenu.addButton(unloads);

		// A menu without a template item is a broken menu, so say so rather than failing on the clone
		await expect(button.show(contextMenu)).rejects.toThrow(/No buttons to clone off contextMenu found/);
	});
});

describe("button text", () => {
	test("is set on the shown button", async () => {
		const contextMenu = contextMenuElem();
		const button = ContextMenu.addButton(unloads);
		const label = await button.show(contextMenu);

		button.text = "Add to queue";

		expect(button.text).toBe("Add to queue");
		expect(label?.innerText).toBe("Add to queue");
	});

	test("is set when the button is shown later", async () => {
		const contextMenu = contextMenuElem();
		const button = ContextMenu.addButton(unloads);
		button.text = "Add to playlist";

		const label = await button.show(contextMenu);

		expect(label?.innerText).toBe("Add to playlist");
	});
});

describe("hide", () => {
	test("removes the item from the menu so it can be shown again", async () => {
		const contextMenu = contextMenuElem();
		const button = ContextMenu.addButton(unloads);
		await button.show(contextMenu);

		button.hide();
		expect(items(contextMenu)).toHaveLength(1);

		await button.show(contextMenu);
		expect(items(contextMenu)).toHaveLength(2);
	});
});

describe("onClick", () => {
	test("runs the click handler without letting the click through", async () => {
		const contextMenu = contextMenuElem();
		const button = ContextMenu.addButton(unloads);
		const label = await button.show(contextMenu);
		const onClick = vi.fn();
		button.onClick(onClick);

		const event = new MouseEvent("click", { bubbles: true, cancelable: true });
		label!.dispatchEvent(event);

		expect(onClick).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	test("runs a click handler set before the button was shown", async () => {
		const contextMenu = contextMenuElem();
		const button = ContextMenu.addButton(unloads);
		const onClick = vi.fn();
		button.onClick(onClick);

		const label = await button.show(contextMenu);
		label!.click();

		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

describe("getCurrent", () => {
	test("is the open context menu", async () => {
		const contextMenu = contextMenuElem();

		expect(await ContextMenu.getCurrent()).toBe(contextMenu);
	});

	test("is null when no context menu opens", async () => {
		vi.useFakeTimers();
		try {
			const current = ContextMenu.getCurrent();
			await vi.advanceTimersByTimeAsync(1000);
			expect(await current).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("onOpen", () => {
	test("is called with the context menu that opened", async () => {
		const received: { event: redux.ActionPayloads["contextMenu/OPEN"]; contextMenu: Element }[] = [];
		ContextMenu.onOpen(unloads, (value) => received.push(value));
		const contextMenu = contextMenuElem();

		tidalAction("contextMenu/OPEN")({ type: "EMPTY_FOLDER", pageType: "page", position: [0, 0], id: "1" });
		await flush();

		expect(received).toHaveLength(1);
		expect(received[0].event).toMatchObject({ type: "EMPTY_FOLDER", id: "1" });
		expect(received[0].contextMenu).toBe(contextMenu);
	});

	test("stops being called when its unloads are run", async () => {
		const receiver = vi.fn();
		ContextMenu.onOpen(unloads, receiver);
		contextMenuElem();

		tidalAction("contextMenu/OPEN")({ type: "EMPTY_FOLDER", pageType: "page", position: [0, 0], id: "2" });
		await flush();
		expect(receiver).toHaveBeenCalledTimes(1);

		await unloadSet(unloads);

		tidalAction("contextMenu/OPEN")({ type: "EMPTY_FOLDER", pageType: "page", position: [0, 0], id: "3" });
		await flush();
		expect(receiver).toHaveBeenCalledTimes(1);
	});

	test("is not called when there is no context menu open", async () => {
		const receiver = vi.fn();
		ContextMenu.onOpen(unloads, receiver);

		vi.useFakeTimers();
		try {
			tidalAction("contextMenu/OPEN")({ type: "EMPTY_FOLDER", pageType: "page", position: [0, 0], id: "4" });
			await vi.advanceTimersByTimeAsync(1000);
			expect(receiver).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("onMediaItem", () => {
	test("is called with the media items of a multi item context menu", async () => {
		const received: { mediaCollection: MediaItems | Album | Playlist; contextMenu: Element }[] = [];
		ContextMenu.onMediaItem(unloads, (value) => received.push(value));
		const contextMenu = contextMenuElem();

		tidalAction("contextMenu/OPEN_MULTI_MEDIA_ITEM")({ ids: [11, 22], position: [0, 0], id: "1" });
		await flush();

		expect(received).toHaveLength(1);
		expect(received[0].mediaCollection).toBeInstanceOf(MediaItems);
		expect((received[0].mediaCollection as MediaItems).tMediaItems).toEqual([
			{ item: { id: 11 }, type: "track" },
			{ item: { id: 22 }, type: "track" },
		]);
		expect(received[0].contextMenu).toBe(contextMenu);
	});

	test("is called with the media item of a single item context menu", async () => {
		const received: { mediaCollection: MediaItems | Album | Playlist; contextMenu: Element }[] = [];
		ContextMenu.onMediaItem(unloads, (value) => received.push(value));
		contextMenuElem();

		tidalAction("contextMenu/OPEN_MEDIA_ITEM")({ id: 33, canBlock: false, contextMenuLocation: "trackList", position: [0, 0] });
		await flush();

		expect(received).toHaveLength(1);
		expect((received[0].mediaCollection as MediaItems).tMediaItems).toEqual([{ item: { id: 33 }, type: "track" }]);
	});

	test("stops being called when its unloads are run", async () => {
		const receiver = vi.fn();
		ContextMenu.onMediaItem(unloads, receiver);
		contextMenuElem();

		tidalAction("contextMenu/OPEN_MULTI_MEDIA_ITEM")({ ids: [44], position: [0, 0], id: "1" });
		await flush();
		expect(receiver).toHaveBeenCalledTimes(1);

		await unloadSet(unloads);

		tidalAction("contextMenu/OPEN_MULTI_MEDIA_ITEM")({ ids: [55], position: [0, 0], id: "2" });
		await flush();
		expect(receiver).toHaveBeenCalledTimes(1);
	});
});
