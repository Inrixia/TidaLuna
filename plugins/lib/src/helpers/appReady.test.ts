import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/** Load the helper fresh, since it answers once for the page and a reload is a new page */
const load = async () => (await import("./appReady")).whenAppReady;

/** TIDAL's own interface: the sidebar and the page it holds */
const paint = (content = "x".repeat(300)) => {
	document.body.innerHTML = `<nav></nav><main>${content}</main>`;
};

beforeEach(() => {
	vi.resetModules();
	document.body.innerHTML = "";
});

afterEach(() => vi.useRealTimers());

describe("whenAppReady", () => {
	test("answers at once when TIDAL has already painted", async () => {
		paint();
		const whenAppReady = await load();
		await expect(whenAppReady(new Set())).resolves.toBe(true);
	});

	test("waits for the page, not just the sidebar", async () => {
		// The sidebar appears while the page is still an empty outline
		document.body.innerHTML = `<nav></nav>`;
		const whenAppReady = await load();
		let ready: boolean | undefined;
		const promise = whenAppReady(new Set()).then((answer) => (ready = answer));

		await Promise.resolve();
		expect(ready).toBeUndefined();

		// The page arriving is the event being waited for
		document.body.appendChild(document.createElement("main"));
		await promise;
		expect(ready).toBe(true);
	});

	test("answers false and says so when the shell never arrives, rather than swallowing what waits", async () => {
		vi.useFakeTimers();
		const whenAppReady = await load();
		let answer: boolean | undefined;
		const promise = whenAppReady(new Set(), 1000).then((ready) => (answer = ready));

		await vi.advanceTimersByTimeAsync(1000);
		await promise;
		expect(answer).toBe(false);
	});

	test("answers false when the sidebar arrives but the page never does", async () => {
		vi.useFakeTimers();
		document.body.innerHTML = `<nav></nav>`;
		const whenAppReady = await load();
		let answer: boolean | undefined;
		const promise = whenAppReady(new Set(), 1000).then((ready) => (answer = ready));

		await vi.advanceTimersByTimeAsync(1000);
		await promise;
		expect(answer).toBe(false);
	});

	test("answers every later caller at once with the same promise", async () => {
		paint();
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
		void whenAppReady(unloads, 30_000);
		expect(unloads.size).toBeGreaterThan(0);
		for (const unload of unloads) unload();

		// Nothing is left armed for a page that will never paint
		await vi.advanceTimersByTimeAsync(30_000);
		expect(vi.getTimerCount()).toBe(0);
	});
});
