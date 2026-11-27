import { describe, expect, test } from "vitest";
import path from "node:path";

import { actionTypes } from "../plugins/lib/src/redux/types/actions/actionTypes";
import { scanUsedActionTypes } from "./usedActionTypes";

/**
 * The action types this repo names must exist in TIDAL's action creators.
 *
 * A type TIDAL removed that this repo still names fails only at runtime: `redux.actions["..."]` is `undefined` and
 * calling it throws, or an intercept silently never fires. The agent scenario in #312 existed to catch that; it can be
 * caught here instead, on every PR, because every reference is a string literal and `actionTypes` is already a copy of
 * the live list.
 */
// `import.meta.dirname`, not a URL: `new URL(...).pathname` percent-encodes the spaces in this checkout's path
const repo = path.resolve(import.meta.dirname, "..");

describe("redux action types", () => {
	test("the committed list is sorted and unique, so regenerating it gives a reviewable diff", () => {
		// It is `Object.keys(...).sort()` copied out of TIDAL: an unsorted entry or a duplicate means it was hand-edited
		expect(actionTypes).toEqual([...actionTypes].sort());
		expect(new Set(actionTypes).size).toBe(actionTypes.length);
		// A floor, because a truncated copy would make the check below pass for the wrong reason
		expect(actionTypes.length).toBeGreaterThan(500);
	});

	test("every action type this repo names exists in TIDAL", async () => {
		// `actionTypes` is `as const`, so widen it before looking names up in it
		const known = new Set<string>(actionTypes);
		const unknown = [...(await scanUsedActionTypes(repo))].filter(([type]) => !known.has(type));

		// file: type, so a failure says where to look
		expect(unknown.map(([type, files]) => `${[...new Set(files)].join(", ")}: ${type}`).join("\n")).toBe("");
	});

	test("the scan really finds the references it checks", async () => {
		// Without this, a broken scan would pass the test above by finding nothing
		const used = await scanUsedActionTypes(repo);
		expect(used.size).toBeGreaterThan(20);
		expect(used.has("router/PUSH")).toBe(true);
	});
});
