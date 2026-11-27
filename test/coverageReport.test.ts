import { describe, expect, it } from "vitest";

import { buildComment, change, commentMarker, isSummary, maxFileRows, type Counts, type Summary, type Totals } from "./coverageReport";
import { coverageThresholds } from "./coverageThresholds";

const root = "/repo";

/** Same covered/total for every metric, enough to drive one number per file */
const totals = (covered: number, total: number): Totals => ({
	lines: { covered, total },
	statements: { covered, total },
	branches: { covered, total },
	functions: { covered, total },
});

/** Builds a summary with absolute paths under root and a matching total */
const summary = (files: Record<string, Totals>): Summary => {
	const total = totals(0, 0);
	for (const coverage of Object.values(files)) {
		for (const metric of Object.keys(total) as (keyof Totals)[]) {
			total[metric].covered += coverage[metric].covered;
			total[metric].total += coverage[metric].total;
		}
	}
	return { total, ...Object.fromEntries(Object.entries(files).map(([file, coverage]) => [`${root}/${file}`, coverage])) };
};

const tableRow = (comment: string, label: string) => comment.split("\n").find((line) => line.startsWith(`| ${label} |`));

describe("isSummary", () => {
	it("accepts a vitest summary and rejects anything else that parsed", () => {
		expect(isSummary(summary({ "native/a.ts": totals(1, 2) }))).toBe(true);
		expect(isSummary(undefined)).toBe(false);
		expect(isSummary({})).toBe(false);
		expect(isSummary({ total: { lines: { covered: 1, total: 2 } } })).toBe(false);
		expect(isSummary([1, 2])).toBe(false);
	});
});

describe("buildComment", () => {
	it("warns when a metric is under its floor, and still reports the table", () => {
		const below = coverageThresholds.branches - 5;
		const files = summary({ "native/a.ts": totals(99, 100) });
		files.total.branches = { covered: below, total: 100 };
		const comment = buildComment(files, { root });
		expect(comment).toContain(`> Below the configured floors: branches ${below}% (floor ${coverageThresholds.branches}%).`);
		expect(comment).not.toContain("lines 99% (floor");
		expect(tableRow(comment, "**All**")).toBeDefined();
	});

	it("warns when there is no summary", () => {
		const comment = buildComment(undefined, { root, unavailableBecause: "nope" });
		expect(comment).toContain(commentMarker);
		expect(comment).toContain("No coverage to report: nope.");
	});

	it("shows no changes or files section without a base", () => {
		const comment = buildComment(summary({ "native/a.ts": totals(9, 10) }), { root });
		expect(tableRow(comment, "native")).toBe("| native | 90% (9/10) | 90% (9/10) | 90% (9/10) | 90% (9/10) |");
		expect(comment).not.toContain("<details");
		expect(comment).not.toContain("Compared with");
		expect(comment).not.toContain("to compare against");
	});

	it("says when a pull request run found no base", () => {
		const comment = buildComment(summary({ "native/a.ts": totals(9, 10) }), { root, baseRef: "dev" });
		expect(comment).toContain("No coverage from dev to compare against.");
	});

	it("shows nothing changed when the base is the same", () => {
		const files = { "native/a.ts": totals(9, 10) };
		const comment = buildComment(summary(files), { root, base: summary(files), baseRef: "dev", baseSha: "abcdef1234567" });
		expect(comment).toContain("**90% lines** · 90% statements · 90% branches · 90% functions");
		expect(tableRow(comment, "native")).toBe("| native | 90% (9/10) | 90% (9/10) | 90% (9/10) | 90% (9/10) |");
		expect(comment).not.toContain("<details");
		expect(comment).toContain("Compared with dev @ abcdef1.");
	});

	it("marks gains with + and drops with 🔻, against the base", () => {
		const comment = buildComment(summary({ "native/a.ts": totals(8, 10), "render/b.ts": totals(10, 10) }), {
			root,
			base: summary({ "native/a.ts": totals(9, 10), "render/b.ts": totals(5, 10) }),
		});
		expect(tableRow(comment, "native")).toBe("| native | 80% (8/10) -10% 🔻 | 80% (8/10) -10% 🔻 | 80% (8/10) -10% 🔻 | 80% (8/10) -10% 🔻 |");
		expect(tableRow(comment, "render")).toBe("| render | 100% (10/10) +50% | 100% (10/10) +50% | 100% (10/10) +50% | 100% (10/10) +50% |");
		expect(comment).toContain("**90% lines** +20% ·");
	});

	it("treats a change that rounds to 0 as none", () => {
		const comment = buildComment(summary({ "native/a.ts": totals(1000, 2000) }), { root, base: summary({ "native/a.ts": totals(1001, 2001) }) });
		expect(tableRow(comment, "native")).toBe("| native | 50% (1000/2000) | 50% (1000/2000) | 50% (1000/2000) | 50% (1000/2000) |");
		expect(comment).not.toContain("<details");
	});

	it("labels new and removed areas", () => {
		const comment = buildComment(summary({ "plugins/foo/src/a.ts": totals(1, 2) }), { root, base: summary({ "build/b.ts": totals(1, 2) }) });
		expect(tableRow(comment, "plugins/foo (new)")).toBe("| plugins/foo (new) | 50% (1/2) | 50% (1/2) | 50% (1/2) | 50% (1/2) |");
		expect(tableRow(comment, "build")).toBe("| build | removed |  |  |  |");
	});

	it("lists changed files, drops first, open when something dropped", () => {
		const comment = buildComment(
			summary({
				"native/small-drop.ts": totals(9, 10),
				"native/big-drop.ts": totals(5, 10),
				"native/gain.ts": totals(10, 10),
				"native/new.ts": totals(3, 10),
				"native/same.ts": totals(7, 10),
			}),
			{
				root,
				base: summary({
					"native/small-drop.ts": totals(10, 10),
					"native/big-drop.ts": totals(10, 10),
					"native/gain.ts": totals(1, 10),
					"native/same.ts": totals(7, 10),
					"native/gone.ts": totals(1, 1),
				}),
			},
		);
		expect(comment).toContain("<details open><summary>Files with changed coverage: 2 down, 1 up, 1 new, 1 removed</summary>");
		const fileRows = comment
			.slice(comment.indexOf("| File |"))
			.split("\n")
			.filter((line) => line.startsWith("| native/"))
			.map((line) => line.split(" | ")[0].slice(2));
		expect(fileRows).toEqual(["native/big-drop.ts", "native/small-drop.ts", "native/new.ts (new)", "native/gain.ts", "native/gone.ts"]);
		expect(tableRow(comment, "native/big-drop.ts")).toBe("| native/big-drop.ts | 50% -50% 🔻 | 50% -50% 🔻 | 50% -50% 🔻 | 50% -50% 🔻 |");
		expect(tableRow(comment, "native/gone.ts")).toBe("| native/gone.ts | removed |  |  |  |");
	});

	it("collapses the files section when nothing dropped", () => {
		const comment = buildComment(summary({ "native/a.ts": totals(10, 10) }), { root, base: summary({ "native/a.ts": totals(5, 10) }) });
		expect(comment).toContain("<details><summary>Files with changed coverage: 1 up</summary>");
	});

	it(`lists at most ${maxFileRows} files`, () => {
		const files = Object.fromEntries(Array.from({ length: maxFileRows + 5 }, (_, index) => [`native/f${index}.ts`, totals(1, 2)]));
		const comment = buildComment(summary(files), { root, base: summary({}) });
		expect(comment.split("\n").filter((line) => line.startsWith("| native/"))).toHaveLength(maxFileRows);
		expect(comment).toContain("…and 5 more");
	});

	it("escapes file paths so they can't break out of the table", () => {
		const comment = buildComment(summary({ "native/a|<img src=x>`.ts": totals(1, 2) }), { root, base: summary({}) });
		expect(comment).toContain("| native/a\\|\\<img src=x\\>\\`.ts (new) |");
		expect(comment).not.toMatch(/(?<!\\)<img/);
	});
});

describe("base summary keys", () => {
	it("matches a base whose keys were made repo relative when it was uploaded", () => {
		const head = summary({ "native/a.ts": totals(90, 100) });
		// What the Normalise step uploads: the workspace root is gone from the key
		const base: Summary = { total: totals(80, 100), "native/a.ts": totals(80, 100) };

		const comment = buildComment(head, { root, base, baseRef: "master" });

		expect(tableRow(comment, "native") ?? "").toContain("+10%");
		// Anchored at the repo, so the workspace prefix is not mistaken for an area that was removed
		expect(comment).not.toContain("| .. |");
	});

	it("reports no change for a comparison it cannot work out, rather than zero", () => {
		const unreadable: Counts = { covered: Number.NaN, total: 100 };

		// Undefined, not 0: a zero would say the number held still, which is the one thing unknown data cannot claim
		expect(change(unreadable, { covered: 10, total: 100 })).toBeUndefined();
		expect(change({ covered: 40, total: 100 }, unreadable)).toBeUndefined();
		// The comparisons it can make are unaffected
		expect(change({ covered: 40, total: 100 }, { covered: 10, total: 100 })).toBe(30);
		expect(change({ covered: 40, total: 100 }, { covered: 40, total: 100 })).toBe(0);
	});

	it("leaves the file list out when nothing could be compared", () => {
		const head = summary({ "native/a.ts": totals(90, 100) });
		const unreadable = (): Totals => {
			const counts = { covered: Number.NaN, total: 100 };
			return { lines: counts, statements: counts, branches: counts, functions: counts };
		};

		const comment = buildComment(head, { root, base: { total: unreadable(), "native/a.ts": unreadable() }, baseRef: "master" });

		expect(comment).not.toContain("NaN");
		expect(comment).not.toContain("Files with changed coverage");
	});
});
