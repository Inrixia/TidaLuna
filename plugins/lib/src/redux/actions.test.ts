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

	test("there is an action for each builder TIDAL had made when actions.ts was imported", () => {
		expect(Object.keys(actions).sort()).toEqual(Object.keys(buildActions).sort());
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
