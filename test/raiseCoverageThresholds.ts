/**
 * Raises the coverage floors to just under what the suite measures, and rewrites `test/coverageThresholds.ts` when it
 * does. Floors only ever go up: a regression has to fail CI, and a floor nobody raises is a stale number.
 *
 * CI runs this on every push to master/dev and commits the change, so a PR that adds tests doesn't have to touch the
 * file. Locally, run `pnpm run coverage` first, then this.
 *
 * Usage: pnpm run coverage:thresholds
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { coverageMetrics, coverageThresholds, type CoverageMetric } from "./coverageThresholds";

/**
 * Kept a point under the measurement: coverage shifts a little between runs and between platforms (CI records a little
 * differently than Windows does), and a floor that tracks the exact number would fail on that noise alone.
 */
const headroom = 1;

const root = process.cwd();
const summaryPath = path.join(root, "coverage", "coverage-summary.json");
const thresholdsPath = path.join(root, "test", "coverageThresholds.ts");

const header = `/**
 * Coverage floors. Shared by \`vitest.config.ts\` (which enforces them) and \`coverageComment.ts\` (which reports them on
 * the PR), so the number CI enforces and the number the comment says are always the same one.
 *
 * Kept current by \`pnpm run coverage:thresholds\`, which CI runs on every push to master/dev and commits when it raises
 * one. They only ever go up: raise them by adding tests, never by lowering the number to make a build pass.
 */`;

const render = (thresholds: Record<CoverageMetric, number>) => `${header}
export const coverageThresholds = {
${coverageMetrics.map((metric) => `\t${metric}: ${thresholds[metric]},`).join("\n")}
} as const;

export type CoverageMetric = keyof typeof coverageThresholds;
export const coverageMetrics: CoverageMetric[] = [${coverageMetrics.map((metric) => `"${metric}"`).join(", ")}];
`;

let summary: { total: Record<CoverageMetric, { pct: number }> };
try {
	summary = JSON.parse(await readFile(summaryPath, "utf8"));
} catch {
	console.error(`Could not read ${path.relative(root, summaryPath)}. Run \`pnpm run coverage\` first.`);
	process.exit(1);
}

const next: Record<CoverageMetric, number> = { ...coverageThresholds };
const raised: string[] = [];
for (const metric of coverageMetrics) {
	const measured = summary.total[metric].pct;
	const candidate = Math.max(0, Math.floor(measured) - headroom);
	if (candidate <= next[metric]) continue;
	raised.push(`${metric} ${next[metric]}% -> ${candidate}% (measured ${measured.toFixed(2)}%)`);
	next[metric] = candidate;
}

if (raised.length === 0) {
	console.log("Coverage has not moved above the floors, nothing to raise");
} else {
	await writeFile(thresholdsPath, render(next));
	console.log(`Raised the floors in ${path.relative(root, thresholdsPath)}:`);
	for (const line of raised) console.log(`  ${line}`);
}
