import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resetTidalState, setTidalState, type TidalState } from "../../../../test/harness/tidalStore";

import type * as redux from "../redux";
import { PlayState } from "./PlayState";
import { Tidal } from "./Tidal";

/**
 * `Tidal.featureFlags` reads TIDAL's `featureFlags` slice. The harness store is typed from an abbreviated TIDAL state,
 * so the slice is cast in place, as `PlayState.test.ts` does for the slices it writes.
 */
const setFeatureFlags = (flags: redux.FeatureFlags["flags"], userOverrides: redux.FeatureFlags["userOverrides"] = {}) =>
	setTidalState({ featureFlags: { ready: true, flags, userOverrides } } as unknown as Partial<TidalState>);

const flag = (name: string, value: boolean) => ({ created: 0, name, type: "BOOLEAN" as const, value });

beforeEach(() => {
	resetTidalState();
});

afterEach(() => {
	resetTidalState();
});

describe("PlayState", () => {
	test("is the PlayState class", () => {
		expect(Tidal.PlayState).toBe(PlayState);
	});
});

describe("featureFlags", () => {
	test("reads the values of TIDAL's flags", () => {
		setFeatureFlags({ lunarA: flag("lunarA", false), lunarB: flag("lunarB", true) });

		const featureFlags = Tidal.featureFlags;

		expect(featureFlags.lunarA!.value).toBe(false);
		expect(featureFlags.lunarB!.value).toBe(true);
	});

	test("applies the user's overrides to the flags", () => {
		setFeatureFlags({ lunarA: flag("lunarA", false), lunarB: flag("lunarB", false) }, { lunarA: true });

		const featureFlags = Tidal.featureFlags;

		expect(featureFlags.lunarA!.value).toBe(true);
		expect(featureFlags.lunarB!.value).toBe(false);
	});

	test("returns a copy, so writing to it doesn't change TIDAL's store", () => {
		setFeatureFlags({ lunarA: flag("lunarA", false) });

		const featureFlags = Tidal.featureFlags;
		featureFlags.lunarA!.value = true;
		featureFlags.lunarB = flag("lunarB", true);

		expect(Tidal.featureFlags.lunarA!.value).toBe(false);
		expect(Tidal.featureFlags.lunarB).toBeUndefined();
	});

	test("reads the store on each access", () => {
		setFeatureFlags({ lunarA: flag("lunarA", false) });
		expect(Tidal.featureFlags.lunarA!.value).toBe(false);

		setFeatureFlags({ lunarA: flag("lunarA", true) });

		expect(Tidal.featureFlags.lunarA!.value).toBe(true);
	});

	test("an override for a flag TIDAL doesn't have throws", () => {
		// Pinned real behaviour: the getter assumes every override names a flag in `flags` and dereferences it.
		// TIDAL's own overrides are flags it shipped, so this only bites an override left over from another version.
		setFeatureFlags({ lunarA: flag("lunarA", false) }, { lunarGone: true });

		expect(() => Tidal.featureFlags).toThrow(TypeError);
	});
});
