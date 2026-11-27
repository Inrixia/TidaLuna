/**
 * Builds the coverage comment the Test workflow posts on a pull request, and the summary it always writes to the
 * Actions run page.
 *
 * Reads coverage/coverage-summary.json, which `pnpm run coverage:ci` writes. On a pull request run the workflow also
 * downloads the base branch's summary to coverage/base/coverage-summary.json and sets COVERAGE_BASE_REF and
 * COVERAGE_BASE_SHA, and the comment then shows how coverage changed against the base. Writes coverage/comment.md and,
 * when the workflow sets it, GITHUB_STEP_SUMMARY. Run it after the test step with `if: always()`, so a failed run still
 * reports whatever coverage it managed.
 *
 * Usage: pnpm run coverage:comment
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildComment, commentMarker, isSummary, missed } from "./coverageReport";

const root = process.cwd();
const summaryPath = path.join(root, "coverage", "coverage-summary.json");
const baseSummaryPath = path.join(root, "coverage", "base", "coverage-summary.json");
const commentPath = path.join(root, "coverage", "comment.md");

const readJson = async (file: string): Promise<unknown> => {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return undefined;
	}
};

const parsed = await readJson(summaryPath);
const summary = isSummary(parsed) ? parsed : undefined;
// A file that parsed but is not a summary is a different problem from one that is missing, so say which
const unavailableBecause =
	parsed === undefined
		? `${path.relative(root, summaryPath)} was not written (the test step failed before coverage)`
		: `${path.relative(root, summaryPath)} is not a coverage summary`;

// Only there on a pull request run that found a base run with a summary to compare against
const parsedBase = await readJson(baseSummaryPath);
const base = isSummary(parsedBase) ? parsedBase : undefined;
if (parsedBase !== undefined && base === undefined)
	console.warn(`${path.relative(root, baseSummaryPath)} is not a coverage summary, reporting without a change`);

const comment = buildComment(summary, {
	root,
	unavailableBecause,
	base,
	baseRef: process.env.COVERAGE_BASE_REF || undefined,
	baseSha: process.env.COVERAGE_BASE_SHA || undefined,
});
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
