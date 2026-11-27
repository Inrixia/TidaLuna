import { afterEach, describe, expect, test, vi } from "vitest";

import { interceptors, unloadSet, type LunaUnload } from "@luna/core";

// TIDAL's action creators are hooked by exposeTidalInternals.patchAction, so the builder it hands back runs the
// interceptors. Imported for that side effect, the calls below are the ones TIDAL makes.
import "../../../../render/src/exposeTidalInternals.patchAction";
import { interceptActionResp, InterceptTimeoutError } from "./interceptActionResp";

const unloads = new Set<LunaUnload>();

afterEach(async () => {
	vi.useRealTimers();
	await unloadSet(unloads);
});

/** Lets interceptActionResp finish setting up (it awaits the semaphore) and then run the trigger it queued with a setTimeout */
const flush = async () => {
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
};

/** The patched action creator TIDAL builds for `type`: `build(payload)` is what TIDAL dispatches with */
const tidalAction = (type: string) => {
	const actionCreators = { _: (actionType: string) => (payload?: unknown) => ({ type: actionType, payload }) };
	window.patchAction(actionCreators);
	return actionCreators._(type);
};

describe("interceptActionResp", () => {
	test("calls the trigger first, then resolves with the payload of a response action", async () => {
		const trigger = vi.fn();
		const response = interceptActionResp(trigger, unloads, ["playbackControls/SEEK"]);

		await flush();
		expect(trigger).toHaveBeenCalledTimes(1);

		expect(tidalAction("playbackControls/SEEK")(42_000)).toEqual({ type: "playbackControls/SEEK", payload: 42_000 });
		await expect(response).resolves.toBe(42_000);
		// the response interceptor, its timeout and the semaphore release are all gone
		expect(interceptors["playbackControls/SEEK"]).toBeUndefined();
	});

	test("a rejection action rejects with its payload", async () => {
		const response = interceptActionResp(vi.fn(), unloads, ["playbackControls/PLAY"], ["playbackControls/SEEK"]);

		await flush();
		// Attach first: this promise is meant to reject, and nothing else would handle it
		const rejected = expect(response).rejects.toBe(999);
		tidalAction("playbackControls/SEEK")(999);

		await rejected;
		expect(interceptors["playbackControls/PLAY"]).toBeUndefined();
		expect(interceptors["playbackControls/SEEK"]).toBeUndefined();
	});

	test("a timeout rejects with an error a caller can tell from a rejection payload", async () => {
		vi.useFakeTimers();
		const response = interceptActionResp(vi.fn(), unloads, ["playbackControls/PLAY"], ["playbackControls/SEEK"]);
		// Attach first: this promise is meant to reject, and nothing else would handle it
		const rejected = expect(response).rejects.toBeInstanceOf(InterceptTimeoutError);

		await vi.advanceTimersByTimeAsync(5000);

		await rejected;
		// A rejection action rejects with its own payload, which is a value and not this: the difference is what lets a
		// caller decide whether the answer is worth remembering
		expect(interceptors["playbackControls/PLAY"]).toBeUndefined();
		expect(interceptors["playbackControls/SEEK"]).toBeUndefined();
	});

	test("rejects after the 5s timeout when no action arrives", async () => {
		vi.useFakeTimers();
		const response = interceptActionResp(vi.fn(), unloads, ["playbackControls/SEEK"]);
		const rejected = expect(response).rejects.toThrow('[interceptActionResp.TIMEOUT] [["playbackControls/SEEK"],null]');

		let settled = false;
		response.then(
			() => (settled = true),
			() => (settled = true),
		);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(settled, "still waiting one ms before the timeout").toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		await rejected;
		expect(interceptors["playbackControls/SEEK"]).toBeUndefined();
	});

	test("serialises concurrent calls for the same action type", async () => {
		const firstTrigger = vi.fn();
		const first = interceptActionResp(firstTrigger, unloads, ["playbackControls/SEEK"]);
		await flush();
		expect(firstTrigger).toHaveBeenCalledTimes(1);
		expect(interceptors["playbackControls/SEEK"]?.size).toBe(1);

		// The second call waits for the semaphore: it is not triggered and registers no interceptor yet
		const secondTrigger = vi.fn();
		const second = interceptActionResp(secondTrigger, unloads, ["playbackControls/SEEK"]);
		await flush();
		expect(secondTrigger).not.toHaveBeenCalled();
		expect(interceptors["playbackControls/SEEK"]?.size).toBe(1);

		// The first response goes to the first call, which then releases the semaphore for the second
		tidalAction("playbackControls/SEEK")(1);
		await expect(first).resolves.toBe(1);
		await flush();
		expect(secondTrigger).toHaveBeenCalledTimes(1);
		expect(interceptors["playbackControls/SEEK"]?.size).toBe(1);

		tidalAction("playbackControls/SEEK")(2);
		await expect(second).resolves.toBe(2);
		expect(interceptors["playbackControls/SEEK"]).toBeUndefined();
	});

	test("leaves no interceptors behind after it settles", async () => {
		const response = interceptActionResp(vi.fn(), unloads, ["playbackControls/PLAY", "playbackControls/PAUSE"]);
		await flush();
		expect(interceptors["playbackControls/PLAY"]?.size).toBe(1);
		expect(interceptors["playbackControls/PAUSE"]?.size).toBe(1);

		tidalAction("playbackControls/PAUSE")();
		await expect(response).resolves.toBeUndefined();

		expect(interceptors["playbackControls/PLAY"]).toBeUndefined();
		expect(interceptors["playbackControls/PAUSE"]).toBeUndefined();
		expect(Object.keys(interceptors)).toEqual([]);
	});

	test("leaves no timers running after it resolves", async () => {
		vi.useFakeTimers();
		const response = interceptActionResp(vi.fn(), unloads, ["playbackControls/SEEK"]);
		await vi.advanceTimersByTimeAsync(0);

		tidalAction("playbackControls/SEEK")(1);
		await expect(response).resolves.toBe(1);

		// neither the 5s response timeout nor the timers unloadSet races its unloads against are left
		expect(vi.getTimerCount()).toBe(0);
	});

	test("leaves no timers running after it rejects on timeout", async () => {
		vi.useFakeTimers();
		const response = interceptActionResp(vi.fn(), unloads, ["playbackControls/SEEK"]);
		const rejected = expect(response).rejects.toThrow("[interceptActionResp.TIMEOUT]");

		await vi.advanceTimersByTimeAsync(5_000);
		await rejected;

		expect(vi.getTimerCount()).toBe(0);
	});
});
