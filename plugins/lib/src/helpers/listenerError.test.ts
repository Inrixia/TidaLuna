import { LunaPlugin } from "@luna/core";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { listenerError } from "./listenerError";

/**
 * `listenerError` asks `LunaPlugin.fromStack` which plugin a listener's stack belongs to, then logs the error against
 * that plugin and shows it on its card through `setLoadError`; without a plugin it hands the error to the fallback.
 *
 * The harness' LunaPlugin stand-in only implements the loader-facing members, so `fromStack` (the real LunaPlugin.ts
 * matches `<url>.mjs` frames against LunaPlugin.plugins) is added here. `setLoadError` is an instance member of the
 * real class, so the plugin doubles below carry it as well.
 */
const lunaPlugin = LunaPlugin as unknown as { fromStack?: (stack?: string) => unknown };
const pluginDouble = (name = "@test/listener") => ({ name, url: "https://luna/luna.test", setLoadError: vi.fn() });

let fromStack: Mock<(stack?: string) => unknown>;
let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	fromStack = vi.fn<(stack?: string) => unknown>(() => undefined);
	lunaPlugin.fromStack = fromStack;
	errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	delete lunaPlugin.fromStack;
});

describe("listenerError", () => {
	test("runs the fallback when the stack names no plugin", () => {
		const fallback = vi.fn();
		const err = new Error("emitter threw");

		listenerError("play state", fallback)(err);

		expect(fromStack).toHaveBeenCalledWith(err.stack);
		expect(fallback).toHaveBeenCalledWith(err);
		expect(errorLog).not.toHaveBeenCalled();
	});

	test("logs the error against the plugin on the stack and shows it on its card", () => {
		const plugin = pluginDouble();
		fromStack.mockReturnValue(plugin);
		const fallback = vi.fn();
		const err = Object.assign(new Error("boom"), { stack: "Error: boom\n    at https://luna/luna.test.mjs:1:1" });

		listenerError("redux intercept", fallback)(err);

		expect(fromStack).toHaveBeenCalledWith(err.stack);
		expect(errorLog).toHaveBeenCalledWith("[@test/listener] Listener error in redux intercept:", err);
		expect(plugin.setLoadError).toHaveBeenCalledWith("redux intercept: boom");
		expect(fallback).not.toHaveBeenCalled();
	});

	test("uses the stringified value for a thrown non-Error", () => {
		const plugin = pluginDouble();
		fromStack.mockReturnValue(plugin);
		// A listener that throws an object rather than an Error: it has a stack but no message
		const thrown = { stack: "at https://luna/luna.test.mjs:1:1", toString: () => "custom failure" };

		listenerError("play state", vi.fn())(thrown);

		expect(plugin.setLoadError).toHaveBeenCalledWith("play state: custom failure");
	});

	test("passes no stack to fromStack for a thrown primitive", () => {
		const fallback = vi.fn();

		listenerError("play state", fallback)("just a string");

		expect(fromStack).toHaveBeenCalledWith(undefined);
		expect(fallback).toHaveBeenCalledWith("just a string");
		expect(errorLog).not.toHaveBeenCalled();
	});
});
