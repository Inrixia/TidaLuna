import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { safeInterval, safeTimeout } from "./safeTimeout";

describe("safeTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("runs the callback after the delay and is gone from the unloads afterwards", () => {
		const unloads = new Set<() => void>();
		const callback = vi.fn();
		const unload = safeTimeout(unloads, callback, 100);

		expect(unloads.has(unload)).toBe(true);
		expect(unload.source).toBe("safeTimeout");

		vi.advanceTimersByTime(99);
		expect(callback).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(callback).toHaveBeenCalledTimes(1);
		// Removed once fired, so a debounced caller setting it again doesn't pile up entries
		expect(unloads.has(unload)).toBe(false);
	});

	test("cancelling before the delay prevents the callback and removes it", () => {
		const unloads = new Set<() => void>();
		const callback = vi.fn();
		const unload = safeTimeout(unloads, callback, 100);

		unload();
		expect(unloads.has(unload)).toBe(false);

		vi.advanceTimersByTime(1000);
		expect(callback).not.toHaveBeenCalled();
	});

	test("running the unloads set cancels the pending callback", async () => {
		const unloads = new Set<() => void>();
		const callback = vi.fn();
		safeTimeout(unloads, callback, 100);

		for (const unload of [...unloads]) unload();
		vi.advanceTimersByTime(1000);
		expect(callback).not.toHaveBeenCalled();
	});

	test("tolerates a null unloads set", () => {
		const callback = vi.fn();
		const unload = safeTimeout(<any>undefined, callback, 50);
		vi.advanceTimersByTime(50);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(() => unload()).not.toThrow();
	});
});

describe("safeInterval", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("repeats until unloaded and is removed from the set", () => {
		const unloads = new Set<() => void>();
		const callback = vi.fn();
		const unload = safeInterval(unloads, callback, 100);

		expect(unload.source).toBe("safeInterval");
		expect(unloads.has(unload)).toBe(true);

		vi.advanceTimersByTime(350);
		expect(callback).toHaveBeenCalledTimes(3);

		unload();
		expect(unloads.has(unload)).toBe(false);

		vi.advanceTimersByTime(1000);
		expect(callback).toHaveBeenCalledTimes(3);
	});
});
