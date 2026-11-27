import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const shell = (content = "content") => {
	document.body.innerHTML = `<nav></nav><main>${content}</main>`;
};

/** Load the helper fresh, since it answers once for the page and a reload is a new page */
const load = async () => (await import("./appReady")).whenAppReady;

beforeEach(() => {
	vi.resetModules();
	document.body.innerHTML = "";
});

afterEach(() => vi.useRealTimers());

describe("whenAppReady", () => {
	test("resolves at once when TIDAL has already painted", async () => {
		shell("x".repeat(300));
		const whenAppReady = await load();
		await expect(whenAppReady(new Set())).resolves.toBeUndefined();
	});

	test("waits for the content, not just the sidebar", async () => {
		// The sidebar alone appears while the page is still a blank outline
		document.body.innerHTML = `<nav></nav><main>loading</main>`;
		const whenAppReady = await load();
		let ready = false;
		const promise = whenAppReady(new Set()).then(() => (ready = true));

		await Promise.resolve();
		expect(ready).toBe(false);

		// Something changing elsewhere on the page is not the page being up
		document.body.appendChild(document.createElement("div"));
		await Promise.resolve();
		expect(ready).toBe(false);

		// TIDAL paints its own content
		const main = document.querySelector("main")!;
		main.textContent = "x".repeat(300);
		await vi.waitFor(() => expect(ready).toBe(true));
		await promise;
	});

	test("resolves on the cap when the shell never appears, rather than swallowing what is waiting", async () => {
		vi.useFakeTimers();
		const whenAppReady = await load();
		let ready = false;
		void whenAppReady(new Set(), 1000).then(() => (ready = true));

		await vi.advanceTimersByTimeAsync(999);
		expect(ready).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(ready).toBe(true);
	});

	test("answers every later caller at once with the same promise", async () => {
		shell("x".repeat(300));
		const whenAppReady = await load();
		const unloads = new Set<() => unknown>();
		const first = whenAppReady(unloads);
		const second = whenAppReady(unloads);
		expect(second).toBe(first);
		await first;
	});

	test("stops watching the page when the plugin unloads", async () => {
		vi.useFakeTimers();
		const whenAppReady = await load();
		const unloads = new Set<() => unknown>();
		const promise = whenAppReady(unloads, 30_000);
		expect(unloads.size).toBe(1);
		for (const unload of unloads) unload();

		// Nothing is waiting on a page that will never paint, so the cap is not left armed
		await vi.advanceTimersByTimeAsync(30_000);
		expect(vi.getTimerCount()).toBe(0);
		void promise;
	});
});
