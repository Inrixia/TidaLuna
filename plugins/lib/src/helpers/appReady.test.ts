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
		await expect(whenAppReady()).resolves.toBe(true);
	});

	test("waits for the page, not just the sidebar", async () => {
		// The sidebar appears while the page is still an empty outline
		document.body.innerHTML = `<nav></nav>`;
		const whenAppReady = await load();
		let ready: boolean | undefined;
		const promise = whenAppReady().then((answer) => (ready = answer));

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
		const promise = whenAppReady(1000).then((ready) => (answer = ready));

		await vi.advanceTimersByTimeAsync(1000);
		await promise;
		expect(answer).toBe(false);
	});

	test("answers false when the sidebar arrives but the page never does", async () => {
		vi.useFakeTimers();
		document.body.innerHTML = `<nav></nav>`;
		const whenAppReady = await load();
		let answer: boolean | undefined;
		const promise = whenAppReady(1000).then((ready) => (answer = ready));

		await vi.advanceTimersByTimeAsync(1000);
		await promise;
		expect(answer).toBe(false);
	});

	test("answers every later caller at once with the same promise", async () => {
		paint();
		const whenAppReady = await load();
		const first = whenAppReady();
		const second = whenAppReady();
		expect(second).toBe(first);
		await first;
	});

	test("a caller that goes away cannot cancel the wait for everyone after it", async () => {
		// The observation belongs to the page: an unloaded caller used to take the observer with it, leaving later callers
		// awaiting a promise that could never settle
		vi.useFakeTimers();
		const whenAppReady = await load();
		const first = whenAppReady(5000);

		await vi.advanceTimersByTimeAsync(4999);
		// Whatever the first caller does with its own handles, the shared answer still arrives
		paint();
		const second = whenAppReady(5000);
		expect(second).toBe(first);
		await vi.advanceTimersByTimeAsync(1);
		await first;
		expect(vi.getTimerCount()).toBe(0);
	});
});
