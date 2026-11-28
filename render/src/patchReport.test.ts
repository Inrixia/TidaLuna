import { beforeEach, describe, expect, test } from "vitest";

import { PatchReport } from "./patchReport";
import { applyTidalPatches, tidalPatches, type PatchOutcome } from "./tidalPatches";

/**
 * Whether TIDAL's code still matches the patches Luna carries.
 *
 * The distinction that matters is `stale` (the marker is there but the pattern no longer matches, so the fix is silently
 * gone) against `noop` (it matched but changed nothing). `applyTidalPatches` skips both without a word, which is how a
 * TIDAL update can quietly remove a perf fix.
 */

/** A source that carries a patch's marker but none of the structure its pattern needs: the stale case */
const markerOnly = (marker: string) => `const unrelated = 1;\n// ${marker}\nconst more = 2;`;

describe("applyTidalPatches tells a caller what it did", () => {
	test("reports every patch absent for a module none of them target", () => {
		const outcomes = new Map<string, PatchOutcome>();

		applyTidalPatches("const nothing = true;", (patch, outcome) => outcomes.set(patch.name, outcome));

		expect(outcomes.size).toBe(tidalPatches.length);
		expect([...outcomes.values()].every((outcome) => outcome === "absent")).toBe(true);
	});

	test("reports stale when a marker is there but the pattern no longer matches", () => {
		const outcomes = new Map<string, PatchOutcome>();
		// One module carrying every marker, and none of the structure any pattern needs
		applyTidalPatches(markerOnly(tidalPatches.map(({ marker }) => marker).join("\n")), (patch, outcome) => outcomes.set(patch.name, outcome));

		expect(outcomes.size).toBe(tidalPatches.length);
		expect([...outcomes.values()].every((outcome) => outcome === "stale")).toBe(true);
	});

	test("reporting changes nothing about the code it returns", () => {
		const source = markerOnly(tidalPatches[0].marker);

		expect(applyTidalPatches(source, () => {})).toBe(applyTidalPatches(source));
	});
});

describe("PatchReport", () => {
	let report: PatchReport;
	const [first, second] = tidalPatches;

	beforeEach(() => {
		report = new PatchReport();
	});

	test("says unseen for a patch no module has carried yet", () => {
		expect(report.statuses().every(({ state }) => state === "unseen")).toBe(true);
		expect(report.allApplied).toBe(true);
	});

	test("an applied patch is applied", () => {
		report.observe(first, "applied");

		expect(report.statuses().find(({ name }) => name === first.name)).toMatchObject({ state: "applied", modules: 1 });
		expect(report.problems).toEqual([]);
	});

	test("stale wins over noop when modules disagree, because one of them lost the fix", () => {
		report.observe(first, "noop");
		report.observe(first, "stale");

		expect(report.statuses().find(({ name }) => name === first.name)).toMatchObject({ state: "stale", modules: 2 });
		expect(report.problems.map(({ name }) => name)).toEqual([first.name]);
	});

	test("applied wins over stale from another module", () => {
		report.observe(first, "stale");
		report.observe(first, "applied");

		expect(report.statuses().find(({ name }) => name === first.name)).toMatchObject({ state: "applied" });
	});

	test("an absent module does not count as having seen the patch", () => {
		report.observe(second, "absent");

		expect(report.statuses().find(({ name }) => name === second.name)).toMatchObject({ state: "unseen", modules: 0 });
	});

	test("allApplied is false only while a patch actually failed to apply", () => {
		report.observe(first, "applied");
		report.observe(second, "absent");
		expect(report.allApplied).toBe(true);

		report.observe(second, "stale");
		expect(report.allApplied).toBe(false);
	});

	test("reset forgets what was seen", () => {
		report.observe(first, "applied");
		report.reset();

		expect(report.statuses().every(({ state }) => state === "unseen")).toBe(true);
	});
});
