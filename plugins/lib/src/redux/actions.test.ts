import { buildActions, reduxStore } from "@luna/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import { actions } from "./actions";

afterEach(() => vi.restoreAllMocks());

describe("actions", () => {
	test("an action dispatches what TIDAL's builder makes from the payload, and returns dispatch's result", () => {
		const dispatch = vi.spyOn(reduxStore, "dispatch").mockReturnValue("dispatched" as never);

		const result = actions["playbackControls/SEEK"](42);

		// test/setup-dom.ts seeds the builders as (payload) => ({ type, payload })
		expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "playbackControls/SEEK", payload: 42 });
		expect(result).toBe("dispatched");
	});

	test("an action passes all its arguments to TIDAL's builder", async () => {
		// actions.ts copies the builders once at import: seed a spy builder, then load a fresh copy of the module
		vi.resetModules();
		const core = await import("@luna/core");
		const builder = vi.fn((a: unknown, b: unknown) => ({ type: "test/TWO_ARGS", payload: [a, b] }));
		core.buildActions["test/TWO_ARGS"] = builder;
		const dispatch = vi.spyOn(core.reduxStore, "dispatch").mockReturnValue(undefined as never);
		try {
			const fresh = (await import("./actions")).actions as unknown as Record<string, (...args: unknown[]) => unknown>;
			fresh["test/TWO_ARGS"](1, 2);
			expect(builder).toHaveBeenCalledExactlyOnceWith(1, 2);
			expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "test/TWO_ARGS", payload: [1, 2] });
		} finally {
			delete core.buildActions["test/TWO_ARGS"];
		}
	});

	test("every builder TIDAL had made when actions.ts was imported has an action that dispatches that builder's action", () => {
		const dispatch = vi.spyOn(reduxStore, "dispatch").mockReturnValue(undefined as never);
		const names = Object.keys(buildActions);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(actions).toHaveProperty([name]);
			(actions as unknown as Record<string, (payload: unknown) => unknown>)[name](1);
			expect(dispatch).toHaveBeenLastCalledWith(buildActions[name](1));
		}
		expect(dispatch).toHaveBeenCalledTimes(names.length);
	});

	test("a builder TIDAL makes later doesn't become an action", () => {
		const type = "test/BUILT_LATER";
		buildActions[type] = (payload?: unknown) => ({ type, payload });
		try {
			expect(type in actions).toBe(false);
		} finally {
			delete buildActions[type];
		}
	});
});
