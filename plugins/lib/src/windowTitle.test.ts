import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { LunaUnload } from "@luna/core";

import { setWindowTitle } from "./windowTitle";

/**
 * `windowTitle.ts` observes the title bar from module scope and remembers the last title element it saw, so each test
 * mounts its own title bar. happy-dom delivers the mutation records in a microtask, `flush` is what makes the observer
 * have run.
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The title TIDAL is given on its title bar, which `setWindowTitle` puts back when its unload runs */
const lunaTitle = 'TIDA<b><span style="color: #32f4ff;">Luna</span></b>\t<span style="color: red;">BETA</span>';

/** TIDAL renders `_mainContainer > _bar > _title`, with a random suffix on each class name */
let mountCount = 0;
const mountTitleBar = (text = "TIDAL") => {
	const container = document.createElement("div");
	container.className = `_mainContainer_${mountCount++}`;
	container.innerHTML = `<div class="_bar_abc"><div class="_title_abc">${text}</div></div>`;
	document.body.append(container);
	return container.querySelector("div[class^='_title']") as HTMLElement;
};

let unloads: Set<LunaUnload>;

beforeEach(() => {
	unloads = new Set();
});

afterEach(() => {
	for (const unload of [...unloads]) unload();
	document.body.innerHTML = "";
});

describe("the Luna title", () => {
	test("replaces the title of a title bar TIDAL renders", async () => {
		const title = mountTitleBar();

		await flush();

		expect(title.innerHTML).toBe(lunaTitle);
	});

	test("is put on the title bar TIDAL renders again after a re-render", async () => {
		const first = mountTitleBar();
		await flush();

		// TIDAL re-renders its title bar, e.g. after a login
		const second = mountTitleBar();
		await flush();

		expect(second.innerHTML).toBe(lunaTitle);
		// The title that was there before is not touched again
		first.innerHTML = "left alone";
		await flush();
		expect(first.innerHTML).toBe("left alone");
	});
});

describe("setWindowTitle", () => {
	test("sets the title of the title bar", async () => {
		const title = mountTitleBar();
		await flush();

		setWindowTitle(unloads, "<b>Now playing</b>");

		expect(title.innerHTML).toBe("<b>Now playing</b>");
	});

	test("sets the title on the title bar TIDAL rendered most recently", async () => {
		mountTitleBar();
		await flush();
		const reRendered = mountTitleBar();
		await flush();

		setWindowTitle(unloads, "<b>Now playing</b>");

		expect(reRendered.innerHTML).toBe("<b>Now playing</b>");
	});

	test("returns an unload, added to unloads, that puts the Luna title back", async () => {
		const title = mountTitleBar();
		await flush();

		const unload = setWindowTitle(unloads, "<b>Now playing</b>");
		expect(unloads.has(unload)).toBe(true);

		unload();

		expect(title.innerHTML).toBe(lunaTitle);
		// The unload takes itself out of the set, so running the set doesn't run it twice
		expect(unloads.has(unload)).toBe(false);
	});

	test("running the unload twice is harmless", async () => {
		const title = mountTitleBar();
		await flush();
		const unload = setWindowTitle(unloads, "<b>Now playing</b>");

		unload();
		unload();

		expect(title.innerHTML).toBe(lunaTitle);
	});

	test("only removes its own unload from unloads", async () => {
		const title = mountTitleBar();
		await flush();
		const other = () => {};
		unloads.add(other);
		const unload = setWindowTitle(unloads, "<b>Now playing</b>");

		unload();

		expect(unloads.has(other)).toBe(true);
		expect(title.innerHTML).toBe(lunaTitle);
	});

	test("does nothing when TIDAL has rendered no title bar", () => {
		// The title element it remembers is from before this test, and is no longer in the document
		expect(() => setWindowTitle(unloads, "<b>Now playing</b>")).not.toThrow();
	});

	test("a title set before TIDAL renders the title bar is not kept", async () => {
		setWindowTitle(unloads, "<b>Now playing</b>");

		// The observer sets the Luna title on the title bar TIDAL renders, not the one set earlier
		const title = mountTitleBar();
		await flush();

		expect(title.innerHTML).toBe(lunaTitle);
	});
});
