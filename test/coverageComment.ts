/**
 * Builds the coverage comment the Test workflow posts on a pull request, and the summary it always writes to the
 * Actions run page.
 *
 * Reads coverage/coverage-summary.json, which `pnpm run coverage:ci` writes. Writes coverage/comment.md and, when the
 * workflow sets it, GITHUB_STEP_SUMMARY. Run it after the test step with `if: always()`, so a failed run still reports
 * whatever coverage it managed.
 *
 * Usage: pnpm run coverage:comment
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { coverageMetrics, coverageThresholds, type CoverageMetric } from "./coverageThresholds";

/** The marker the workflow looks for, so a later run updates this comment instead of adding another one */
export const commentMarker = "<!-- luna-coverage -->";

type Counts = { covered: number; total: number };
type FileCoverage = Record<CoverageMetric, Counts & { pct: number }>;
type Summary = Record<string, FileCoverage>;

const root = process.cwd();
const summaryPath = path.join(root, "coverage", "coverage-summary.json");
const commentPath = path.join(root, "coverage", "comment.md");

/** `plugins/lib/src/classes/Playlist.ts` reads better as `plugins/lib` in a summary table */
const areaOf = (relativePath: string) => {
	const parts = relativePath.split("/");
	// plugins/<name>/... is one area per plugin; everything else groups by its top folder
	return parts[0] === "plugins" && parts[1] !== undefined ? `plugins/${parts[1]}` : parts[0];
};

const percentage = (counts: Counts) => (counts.total === 0 ? 100 : (counts.covered / counts.total) * 100);
const format = (percentage: number) => `${Number(percentage.toFixed(1))}%`;

const add = (target: Counts, counts: Counts) => {
	target.covered += counts.covered;
	target.total += counts.total;
};

const emptyCounts = (): Record<CoverageMetric, Counts> => ({
	lines: { covered: 0, total: 0 },
	statements: { covered: 0, total: 0 },
	branches: { covered: 0, total: 0 },
	functions: { covered: 0, total: 0 },
});

/** Per-area totals, in the order the areas first appear (the summary is grouped by folder already) */
const byArea = (summary: Summary) => {
	const areas = new Map<string, Record<CoverageMetric, Counts>>();
	for (const [file, coverage] of Object.entries(summary)) {
		if (file === "total") continue;
		const area = areaOf(path.relative(root, file).split(path.sep).join("/"));
		let totals = areas.get(area);
		if (totals === undefined) areas.set(area, (totals = emptyCounts()));
		for (const metric of coverageMetrics) add(totals[metric], coverage[metric]);
	}
	return [...areas.entries()].sort(([a], [b]) => a.localeCompare(b));
};

/**
 * Cell text comes from file paths, which a pull request author controls. Escape what would end the cell or start markup,
 * so a path can't break out of the table or add anything to a comment posted with a write token.
 */
const escapeCell = (text: string) => text.replace(/\|/g, "\\|").replace(/[`<>]/g, (character) => `\\${character}`);

const tableRow = (label: string, totals: Record<CoverageMetric, Counts>) =>
	`| ${escapeCell(label)} | ${coverageMetrics.map((metric) => `${format(percentage(totals[metric]))} (${totals[metric].covered}/${totals[metric].total})`).join(" | ")} |`;

const header = `| Area | ${coverageMetrics.map((metric) => metric[0].toUpperCase() + metric.slice(1)).join(" | ")} |\n| --- | ${coverageMetrics.map(() => "--:").join(" | ")} |`;

/** The metrics that missed their floor, e.g. `branches 67.5% (floor 70%)` */
const missed = (totals: Record<CoverageMetric, Counts>) =>
	coverageMetrics
		.filter((metric) => percentage(totals[metric]) < coverageThresholds[metric])
		.map((metric) => `${metric} ${format(percentage(totals[metric]))} (floor ${coverageThresholds[metric]}%)`);

const buildComment = (summary: Summary | undefined, unavailableBecause?: string) => {
	if (summary === undefined) {
		return [
			commentMarker,
			"## Coverage",
			"",
			`> [!WARNING]`,
			`> No coverage to report: ${unavailableBecause ?? "the tests did not produce a coverage report"}.`,
		].join("\n");
	}

	const total = summary.total;
	const failures = missed(total);
	const lines = [
		commentMarker,
		"## Coverage",
		"",
		`**${format(percentage(total.lines))} lines** · ${coverageMetrics
			.filter((metric) => metric !== "lines")
			.map((metric) => `${format(percentage(total[metric]))} ${metric}`)
			.join(" · ")}`,
		"",
	];

	if (failures.length !== 0) {
		lines.push("> [!WARNING]", `> Below the configured floors: ${failures.join(", ")}.`, "");
	}

	lines.push(header, tableRow("**All**", total), ...byArea(summary).map(([area, totals]) => tableRow(area, totals)));
	lines.push(
		"",
		`<sub>Floors: ${coverageMetrics.map((metric) => `${metric} ${coverageThresholds[metric]}%`).join(", ")}. Report: the run's coverage artifact.</sub>`,
	);
	return lines.join("\n");
};

let summary: Summary | undefined;
let unavailableBecause: string | undefined;
try {
	summary = JSON.parse(await readFile(summaryPath, "utf8"));
} catch {
	unavailableBecause = `${path.relative(root, summaryPath)} was not written (the test step failed before coverage)`;
}

const comment = buildComment(summary, unavailableBecause);
await mkdir(path.dirname(commentPath), { recursive: true });
await writeFile(commentPath, `${comment}\n`);
console.log(`Wrote ${path.relative(root, commentPath)}`);

// The run page gets the same table, which works on fork PRs where the workflow token cannot comment
const stepSummary = process.env.GITHUB_STEP_SUMMARY;
if (stepSummary !== undefined && stepSummary !== "") await appendFile(stepSummary, `${comment.replace(commentMarker, "").trim()}\n`);

if (summary !== undefined) {
	const failures = missed(summary.total);
	if (failures.length !== 0) {
		console.error(`Coverage is below the floors: ${failures.join(", ")}`);
		process.exitCode = 1;
	}
}
