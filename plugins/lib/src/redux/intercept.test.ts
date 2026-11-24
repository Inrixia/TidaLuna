import { afterEach, describe, expect, test, vi } from "vitest";

import { buildActions, interceptors, unloadSet, type LunaUnload } from "@luna/core";

// TIDAL's action creators (`{ _: (type) => builder }`) are hooked by exposeTidalInternals.patchAction: it records the
// builder and hands back a Proxy of it, so calling that builder runs `interceptors[type]` first. Side effect import.
import "../../../../render/src/exposeTidalInternals.patchAction";
import { intercept, interceptPromise } from "./intercept";

const unloads = new Set<LunaUnload>();

afterEach(async () => {
	await unloadSet(unloads);
});

/**
 * The patched action creator TIDAL builds for `type`. `build` is what TIDAL dispatches with: the Proxy that runs the
 * interceptors, so `build(payload)` is exactly the call TIDAL makes. `builder` is the unproxied function behind it.
 */
const tidalAction = (type: string) => {
	const actionCreators = { _: (actionType: string) => (payload?: unknown) => ({ type: actionType, payload }) };
	window.patchAction(actionCreators);
	const build = actionCreators._(type);
	return { build, builder: buildActions[type]! };
};

describe("intercept", () => {
	test("runs the callback with the payload and action type, and lets the action through", () => {
		const cb = vi.fn();
		intercept("playbackControls/SEEK", unloads, cb);
		const { build } = tidalAction("playbackControls/SEEK");

		expect(build(30_000)).toEqual({ type: "playbackControls/SEEK", payload: 30_000 });
		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb).toHaveBeenCalledWith(30_000, "playbackControls/SEEK");
	});

	test("intercepts every action type of an array", () => {
		const cb = vi.fn();
		const unload = intercept(["playbackControls/PLAY", "playbackControls/PAUSE"], unloads, cb);

		tidalAction("playbackControls/PLAY").build();
		tidalAction("playbackControls/PAUSE").build();
		// an action type outside the array is untouched
		tidalAction("playbackControls/SEEK").build(1_000);

		expect(cb.mock.calls).toEqual([
			[undefined, "playbackControls/PLAY"],
			[undefined, "playbackControls/PAUSE"],
		]);
		expect(interceptors["playbackControls/PLAY"]?.size).toBe(1);
		expect(interceptors["playbackControls/PAUSE"]?.size).toBe(1);

		// one unload removes the callback from every type of the array
		unload();
		expect(interceptors["playbackControls/PLAY"]).toBeUndefined();
		expect(interceptors["playbackControls/PAUSE"]).toBeUndefined();
	});

	test("a callback returning true cancels the action", () => {
		intercept("playbackControls/PLAY", unloads, () => true);
		const { build, builder } = tidalAction("playbackControls/PLAY");

		// The Proxy answers with TIDAL's NOOP action instead of calling the builder `buildActions` holds
		expect(build()).toEqual({ type: "NOOP" });
		expect(builder()).toEqual({ type: "playbackControls/PLAY", payload: undefined });
	});

	test("only true cancels: false and undefined let the action dispatch", () => {
		const cancelled = vi.fn(() => false);
		intercept("playbackControls/SEEK", unloads, cancelled);
		const seek = tidalAction("playbackControls/SEEK");
		expect(seek.build(1_000)).toEqual({ type: "playbackControls/SEEK", payload: 1_000 });

		const passthrough = vi.fn(() => undefined);
		intercept("playbackControls/PAUSE", unloads, passthrough);
		const pause = tidalAction("playbackControls/PAUSE");
		expect(pause.build()).toEqual({ type: "playbackControls/PAUSE", payload: undefined });

		expect(cancelled).toHaveBeenCalledTimes(1);
		expect(passthrough).toHaveBeenCalledTimes(1);
	});

	test("once intercepts a single action and unloads itself", () => {
		const cb = vi.fn(() => true);
		intercept("playbackControls/PLAY", unloads, cb, true);
		const { build } = tidalAction("playbackControls/PLAY");

		expect(build()).toEqual({ type: "NOOP" });
		// Removed while it ran, so the second action dispatches untouched
		expect(build()).toEqual({ type: "playbackControls/PLAY", payload: undefined });
		expect(cb).toHaveBeenCalledTimes(1);
		expect(interceptors["playbackControls/PLAY"]).toBeUndefined();
	});

	test("unloading removes the callback and drops the empty interceptor set", () => {
		const cb = vi.fn();
		const unload = intercept("playbackControls/SEEK", unloads, cb);
		expect(unloads.has(unload)).toBe(true);
		expect(interceptors["playbackControls/SEEK"]?.size).toBe(1);

		unload();

		expect(interceptors["playbackControls/SEEK"]).toBeUndefined();
		tidalAction("playbackControls/SEEK").build(1_000);
		expect(cb).not.toHaveBeenCalled();
	});

	test("unloading one of two callbacks for a type keeps the other", () => {
		const first = vi.fn();
		const second = vi.fn();
		const unloadFirst = intercept("playbackControls/SEEK", unloads, first);
		intercept("playbackControls/SEEK", unloads, second);

		unloadFirst();
		expect(interceptors["playbackControls/SEEK"]?.size).toBe(1);

		tidalAction("playbackControls/SEEK").build(1_000);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	test("unloading twice is safe", () => {
		const unload = intercept("playbackControls/PLAY", unloads, () => {});
		unload();
		expect(() => unload()).not.toThrow();
		expect(interceptors["playbackControls/PLAY"]).toBeUndefined();
	});

	test("the returned unload is labelled with the intercepted action types", () => {
		const single = intercept("playbackControls/SEEK", unloads, () => {});
		expect(single.source).toBe('intercept["playbackControls/SEEK"]');

		const many = intercept(["playbackControls/PLAY", "playbackControls/PAUSE"], unloads, () => {});
		expect(many.source).toBe('intercept["playbackControls/PLAY","playbackControls/PAUSE"]');
	});
});

describe("interceptPromise", () => {
	test("resolves with the payload of the next action and cancels it", async () => {
		const promise = interceptPromise("playbackControls/SEEK", unloads, true);
		const { build } = tidalAction("playbackControls/SEEK");

		expect(build(12_000)).toEqual({ type: "NOOP" });

		await expect(promise).resolves.toBe(12_000);
		// only the first action was intercepted
		expect(interceptors["playbackControls/SEEK"]).toBeUndefined();
	});

	test("without cancel resolves and lets the action dispatch", async () => {
		const promise = interceptPromise("playbackControls/SEEK", unloads);
		const { build } = tidalAction("playbackControls/SEEK");

		expect(build(12_000)).toEqual({ type: "playbackControls/SEEK", payload: 12_000 });

		await expect(promise).resolves.toBe(12_000);
		expect(interceptors["playbackControls/SEEK"]).toBeUndefined();
	});
});
