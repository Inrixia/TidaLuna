import { afterEach, describe, expect, test, vi } from "vitest";

import { interceptors, unloadSet, type LunaUnload } from "@luna/core";

// TIDAL's action creators are hooked by exposeTidalInternals.patchAction, so the builder it hands back runs the
// interceptors. Imported for that side effect, the calls below are the ones TIDAL makes.
import "../../../../render/src/exposeTidalInternals.patchAction";
import { interceptActionResp, InterceptActionRespFail } from "./interceptActionResp";

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

	test("a rejection action rejects, with its type and payload reachable on the error", async () => {
		const response = interceptActionResp(vi.fn(), unloads, ["playbackControls/PLAY"], ["playbackControls/SEEK"]);
		const settled = response.then(
			(value) => ({ value }),
			(error) => ({ error }),
		);

		await flush();
		tidalAction("playbackControls/SEEK")(999);

		const result = await settled;
		expect(result).not.toHaveProperty("value");
		const error = (result as { error: unknown }).error;
		expect(error).toBeInstanceOf(InterceptActionRespFail);
		expect(error).toMatchObject({
			actionType: "playbackControls/SEEK",
			payload: 999,
			message: "[interceptActionResp.FAIL] playbackControls/SEEK",
		});
		expect(interceptors["playbackControls/PLAY"]).toBeUndefined();
		expect(interceptors["playbackControls/SEEK"]).toBeUndefined();
	});

	test("a response action still resolves when rejection actions are given", async () => {
		const response = interceptActionResp(vi.fn(), unloads, ["playbackControls/PLAY"], ["playbackControls/SEEK"]);

		await flush();
		tidalAction("playbackControls/PLAY")(7);

		await expect(response).resolves.toBe(7);
		expect(Object.keys(interceptors)).toEqual([]);
	});

	test("unloading the caller's unloads removes the interceptors and leaves the call pending", async () => {
		vi.useFakeTimers();
		const callerUnloads = new Set<LunaUnload>();
		const response = interceptActionResp(vi.fn(), callerUnloads, ["playbackControls/PLAY"], ["playbackControls/SEEK"]);
		let settled = false;
		response.then(
			() => (settled = true),
			() => (settled = true),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(interceptors["playbackControls/PLAY"]?.size).toBe(1);
		expect(interceptors["playbackControls/SEEK"]?.size).toBe(1);

		await unloadSet(callerUnloads);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(interceptors["playbackControls/PLAY"]).toBeUndefined();
		expect(interceptors["playbackControls/SEEK"]).toBeUndefined();
		expect(settled).toBe(false);
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
});
