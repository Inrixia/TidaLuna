import path from "node:path";

import { describe, expect, test } from "vitest";

import { buildComment, byArea, commentMarker, format, formatDelta, percentagesOf, type Summary } from "./coverageFormat";
import { coverageThresholds } from "./coverageThresholds";

/**
 * The coverage comment and the baseline a pull request diffs against.
 *
 * The change is the part worth testing: a table of absolute numbers cannot say whether a pull request helped, and a
 * delta that rounds to zero has to read as "no change" rather than as a number that moved.
 */
const at = (relative: string) => path.join(process.cwd(), relative);

/** Every metric the same, which keeps the assertions about the shape of the row rather than about four numbers */
const coverage = (pct: number, covered = Math.round(pct), total = 100) => ({
	lines: { covered, total, pct },
	statements: { covered, total, pct },
	branches: { covered, total, pct },
	functions: { covered, total, pct },
});

const summary = (files: Record<string, number>, total = 80): Summary => {
	const built: Summary = { total: coverage(total) };
	for (const [name, pct] of Object.entries(files)) built[at(name)] = coverage(pct);
	return built;
};

describe("formatDelta", () => {
	test("signs the change, and marks no change", () => {
		expect(formatDelta(79.2, 78.8)).toBe("+0.4");
		expect(formatDelta(78.6, 78.8)).toBe("-0.2");
		expect(formatDelta(78.8, 78.8)).toBe("±0");
		// Rounds to nothing: printing +0.0 would claim a change that did not happen
		expect(formatDelta(78.82, 78.8)).toBe("±0");
	});

	test("has nothing to say without a baseline", () => {
		expect(formatDelta(78.8, undefined)).toBeUndefined();
		expect(formatDelta(78.8, Number.NaN)).toBeUndefined();
	});
});

describe("byArea", () => {
	test("one area per plugin, and one per top folder otherwise", () => {
		const areas = byArea(summary({ "plugins/lib/src/a.ts": 50, "plugins/lib/src/b.ts": 100, "render/src/c.ts": 0 }));

		expect(areas.map(([area]) => area)).toEqual(["plugins/lib", "render"]);
		// Two files of 100 lines each: 50 covered and 100 covered
		expect(areas[0][1].lines).toEqual({ covered: 150, total: 200 });
	});
});

describe("buildComment", () => {
	test("gives the number alone when there is no baseline", () => {
		const comment = buildComment(summary({ "render/src/a.ts": 80 }));

		expect(comment.startsWith(commentMarker)).toBe(true);
		expect(comment).toContain("**80% lines** ·");
		expect(comment).toContain("| **All** | 80% (80/100)");
		// No change to report, so no change is claimed
		expect(comment).not.toContain("(+");
		expect(comment).not.toContain("(±0)");
	});

	test("puts the change beside every number when there is a baseline", () => {
		const comment = buildComment(summary({ "render/src/a.ts": 90 }, 80), {
			total: percentagesOf(coverage(78)),
			areas: { render: percentagesOf(coverage(80)) },
		});

		expect(comment).toContain("**80% lines** (+2.0)");
		expect(comment).toContain("| **All** | 80% (+2.0) (80/100)");
		// Row moved 90 now against 80 before
		expect(comment).toContain("| render | 90% (+10.0) (90/100)");
	});

	test("says which baseline the change is against", () => {
		const comment = buildComment(summary({ "render/src/a.ts": 80 }), { total: percentagesOf(coverage(80)) }, "master");

		expect(comment).toContain("Change is against master");
	});

	test("shows a drop rather than hiding it", () => {
		const comment = buildComment(summary({ "render/src/a.ts": 70 }, 70), { total: percentagesOf(coverage(75)) });

		expect(comment).toContain("**70% lines** (-5.0)");
	});

	test("warns when a metric is under its floor, and still reports the rest", () => {
		const below = coverageThresholds.branches - 5;
		const comment = buildComment(summary({ "render/src/a.ts": 80 }, below));

		expect(comment).toContain("Below the configured floors");
		expect(comment).toContain(`branches ${format(below)}`);
		expect(comment).toContain("| **All** |");
	});

	test("reports that there is nothing to report when the run produced no summary", () => {
		const comment = buildComment(undefined, undefined, "master", "the test step failed before coverage");

		expect(comment).toContain(commentMarker);
		expect(comment).toContain("No coverage to report: the test step failed before coverage.");
	});

	test("escapes a path that would break the table", () => {
		// The area comes from a file path, which a pull request author controls
		const comment = buildComment(summary({ "plugins/we|ird<x>/src/a.ts": 80 }));

		expect(comment).toContain("plugins/we\\|ird\\<x\\>");
	});

	test("reads an empty total as fully covered rather than dividing by zero", () => {
		const empty: Summary = { total: coverage(0, 0, 0) };

		expect(buildComment(empty)).toContain("**100% lines**");
	});
});
