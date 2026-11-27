/**
 * Builds the coverage comment and the committed baseline, kept pure so it can be tested.
 *
 * `coverageComment.ts` writes the comment, `coverageBadge.ts` writes the percentages the next pull request compares
 * against. Both go through here so the table and the baseline always describe the same rows.
 *
 * A percentage on its own does not say whether a pull request helped, so every number is paired with its change from the
 * baseline when one is available. That is the thing a reviewer is actually asking: not "what is it", but "did it move".
 */
import path from "node:path";

import { coverageMetrics, coverageThresholds, type CoverageMetric } from "./coverageThresholds";

export type Counts = { covered: number; total: number };
export type FileCoverage = Record<CoverageMetric, Counts & { pct: number }>;
export type Summary = Record<string, FileCoverage>;
/** Percentages only: small enough to commit beside the badges, and all the next run needs to diff against */
export type Percentages = Record<CoverageMetric, number>;
export type Baseline = { total?: Percentages; areas?: Record<string, Percentages> };

/** The marker the workflow looks for, so a later run updates this comment instead of adding another one */
export const commentMarker = "<!-- luna-coverage -->";

/** `plugins/lib/src/classes/Playlist.ts` reads better as `plugins/lib` in a summary table */
export const areaOf = (relativePath: string) => {
	const parts = relativePath.split("/");
	// plugins/<name>/... is one area per plugin; everything else groups by its top folder
	return parts[0] === "plugins" && parts[1] !== undefined ? `plugins/${parts[1]}` : parts[0];
};

export const percentage = (counts: Counts) => (counts.total === 0 ? 100 : (counts.covered / counts.total) * 100);
export const format = (percentage: number) => `${Number(percentage.toFixed(1))}%`;

export const emptyCounts = (): Record<CoverageMetric, Counts> => ({
	lines: { covered: 0, total: 0 },
	statements: { covered: 0, total: 0 },
	branches: { covered: 0, total: 0 },
	functions: { covered: 0, total: 0 },
});

const add = (target: Counts, counts: Counts) => {
	target.covered += counts.covered;
	target.total += counts.total;
};

/**
 * Per-area totals, in the order the areas first appear (the summary is grouped by folder already).
 *
 * @param root What a summary's absolute paths are relative to. Passed rather than read from `process.cwd()`, so the
 * grouping does not depend on where the script happens to run.
 */
export const byArea = (summary: Summary, root = process.cwd()) => {
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

/** Whether a parsed file is the summary vitest wrote, rather than anything else that happened to parse */
export const isSummary = (value: unknown): value is Summary => {
	const total = (value as Summary | undefined)?.total;
	return total !== undefined && coverageMetrics.every((metric) => typeof total[metric]?.covered === "number");
};

/**
 * A row's percentages, as both the baseline file and the delta lookup want them.
 *
 * Rounded to one decimal, the precision the comment prints, so a stored baseline and the number shown beside it always
 * agree. Keeping the full float would make the file unreadable and let a delta claim a move smaller than the display
 * can show.
 */
export const percentagesOf = (totals: Record<CoverageMetric, Counts>): Percentages =>
	Object.fromEntries(coverageMetrics.map((metric) => [metric, Number(percentage(totals[metric]).toFixed(1))])) as Percentages;

/**
 * The change from `baseline` to `current`, as `+0.4` / `-0.2` / `±0`.
 *
 * Undefined when there is nothing to compare against, which the table shows by leaving the cell alone rather than
 * printing a zero that would claim the number did not move.
 */
export const formatDelta = (current: number, baseline: number | undefined) => {
	if (baseline === undefined || !Number.isFinite(baseline)) return undefined;
	const delta = current - baseline;
	// Below a tenth of a point it rounds to nothing, and printing `+0.0` reads as a change that did not happen
	if (Math.abs(delta) < 0.05) return "±0";
	return `${delta > 0 ? "+" : "-"}${Math.abs(delta).toFixed(1)}`;
};

/** `78.9% (+0.4)`, or just the percentage when there is no baseline */
const withDelta = (current: number, baseline: number | undefined) => {
	const delta = formatDelta(current, baseline);
	return delta === undefined ? format(current) : `${format(current)} (${delta})`;
};

/**
 * Cell text comes from file paths, which a pull request author controls. Escape what would end the cell or start markup,
 * so a path can't break out of the table or add anything to a comment posted with a write token.
 */
const escapeCell = (text: string) => text.replace(/\|/g, "\\|").replace(/[`<>]/g, (character) => `\\${character}`);

const tableRow = (label: string, totals: Record<CoverageMetric, Counts>, baseline?: Percentages) =>
	`| ${escapeCell(label)} | ${coverageMetrics
		.map((metric) => {
			const current = percentage(totals[metric]);
			return `${withDelta(current, baseline?.[metric])} (${totals[metric].covered}/${totals[metric].total})`;
		})
		.join(" | ")} |`;

const header = `| Area | ${coverageMetrics.map((metric) => metric[0].toUpperCase() + metric.slice(1)).join(" | ")} |\n| --- | ${coverageMetrics.map(() => "--:").join(" | ")} |`;

/** The metrics that missed their floor, e.g. `branches 67.5% (floor 70%)` */
export const missed = (totals: Record<CoverageMetric, Counts>) =>
	coverageMetrics
		.filter((metric) => percentage(totals[metric]) < coverageThresholds[metric])
		.map((metric) => `${metric} ${format(percentage(totals[metric]))} (floor ${coverageThresholds[metric]}%)`);

/**
 * @param baseline Percentages from the base branch, so each row can show its change. Absent on a first run, or when the
 * base branch predates the baseline file, in which case the table shows the numbers alone.
 * @param baselineLabel What the baseline is, named in the footnote: `master`, usually.
 */
export const buildComment = (summary: Summary | undefined, baseline?: Baseline, baselineLabel = "the base branch", unavailableBecause?: string) => {
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
	const totalPercentages = percentagesOf(total);
	const change = (metric: CoverageMetric) => {
		const delta = formatDelta(totalPercentages[metric], baseline?.total?.[metric]);
		return delta === undefined ? "" : ` (${delta})`;
	};
	const lines = [
		commentMarker,
		"## Coverage",
		"",
		`**${format(totalPercentages.lines)} lines**${change("lines")} · ${coverageMetrics
			.filter((metric) => metric !== "lines")
			.map((metric) => `${format(totalPercentages[metric])} ${metric}${change(metric)}`)
			.join(" · ")}`,
		"",
	];

	if (failures.length !== 0) {
		lines.push("> [!WARNING]", `> Below the configured floors: ${failures.join(", ")}.`, "");
	}

	lines.push(
		header,
		tableRow("**All**", total, baseline?.total),
		...byArea(summary).map(([area, totals]) => tableRow(area, totals, baseline?.areas?.[area])),
	);
	lines.push(
		"",
		`<sub>Change is against ${baselineLabel}, from the committed baseline. Floors: ${coverageMetrics
			.map((metric) => `${metric} ${coverageThresholds[metric]}%`)
			.join(", ")}. Report: the run's coverage artifact.</sub>`,
	);
	return lines.join("\n");
};
