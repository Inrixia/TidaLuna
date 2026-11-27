/**
 * Writes the shields.io endpoint badges the README links to, from the coverage run's summary.
 *
 * Run after `pnpm run coverage`, which writes coverage/coverage-summary.json. The json files under
 * .github/badges are committed, because shields reads them over raw.githubusercontent.com.
 *
 * Usage: pnpm run coverage:badge
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { byArea, percentagesOf, type Summary } from "./coverageFormat";

const root = process.cwd();
const summaryPath = path.join(root, "coverage", "coverage-summary.json");
const badgeDir = path.join(root, ".github", "badges");

/** shields colours, by how happy the number is */
const colourFor = (percentage: number) =>
	percentage >= 90
		? "brightgreen"
		: percentage >= 80
			? "green"
			: percentage >= 70
				? "yellowgreen"
				: percentage >= 60
					? "yellow"
					: percentage >= 50
						? "orange"
						: "red";

/** Trailing zeros off, so 70% doesn't render as "70.00%" */
const format = (percentage: number) => `${Number(percentage.toFixed(1))}%`;

const badge = (label: string, percentage: number) => ({
	schemaVersion: 1,
	label,
	message: format(percentage),
	color: colourFor(percentage),
});

const write = async (file: string, contents: unknown) => {
	await mkdir(badgeDir, { recursive: true });
	await writeFile(path.join(badgeDir, file), `${JSON.stringify(contents, null, "\t")}\n`);
	console.log(`Wrote .github/badges/${file}`);
};

let summary: Summary;
try {
	summary = JSON.parse(await readFile(summaryPath, "utf8"));
} catch {
	console.error(`Could not read ${path.relative(root, summaryPath)}. Run \`pnpm run coverage\` first.`);
	process.exit(1);
}

const lines = summary.total.lines.pct;
await write("coverage.json", badge("coverage", lines));
// A second, stricter view: branch coverage is where a suite is usually weakest
await write("coverage-branches.json", badge("branches", summary.total.branches.pct));

// Percentages only, so a pull request can diff against them to say what moved rather than only what is. Committed on
// master with the badges above, which is what makes it the baseline for the next pull request.
const areas = byArea(summary);
await write("coverage-baseline.json", {
	// Areas the same way the comment groups them, so a row and its change always come from the same key
	total: percentagesOf(summary.total),
	areas: Object.fromEntries(areas.map(([area, counts]) => [area, percentagesOf(counts)])),
});

// Present when the run wrote a json test report (vitest --reporter=json --outputFile=coverage/test-results.json)
const resultsPath = path.join(root, "coverage", "test-results.json");
try {
	const results: { numTotalTests?: number; numPassedTests?: number } = JSON.parse(await readFile(resultsPath, "utf8"));
	if (results.numPassedTests !== undefined) {
		await write("tests.json", {
			schemaVersion: 1,
			label: "tests",
			message: `${results.numPassedTests}${results.numTotalTests !== undefined && results.numTotalTests !== results.numPassedTests ? `/${results.numTotalTests}` : ""} passing`,
			color: "brightgreen",
		});
	}
} catch {
	// No test report in this run, only the coverage badges are written
}
