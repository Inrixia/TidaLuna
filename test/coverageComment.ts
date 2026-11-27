/**
 * Builds the coverage comment the Test workflow posts on a pull request, and the summary it always writes to the
 * Actions run page.
 *
 * Reads coverage/coverage-summary.json, which `pnpm run coverage:ci` writes. Writes coverage/comment.md and, when the
 * workflow sets it, GITHUB_STEP_SUMMARY. Run it after the test step with `if: always()`, so a failed run still reports
 * whatever coverage it managed.
 *
 * Every number is paired with its change from coverage/baseline.json when the workflow fetched one (see
 * .github/workflows/test.yml), so a reviewer sees whether the pull request moved coverage rather than only where it now
 * is. Without a baseline the table still posts; it just has nothing to compare against.
 *
 * Usage: pnpm run coverage:comment
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildComment, commentMarker, isSummary, missed, type Baseline, type Summary } from "./coverageFormat";

const root = process.cwd();
const summaryPath = path.join(root, "coverage", "coverage-summary.json");
const commentPath = path.join(root, "coverage", "comment.md");
/** Fetched from the base branch by the workflow. Absent on a push, or when the fetch found nothing */
const baselinePath = path.join(root, "coverage", "baseline.json");


const readJson = async <T>(file: string): Promise<T | undefined> => {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
};

const parsed = await readJson<unknown>(summaryPath);
const summary = isSummary(parsed) ? parsed : undefined;
// A file that parsed but is not a summary is a different problem from one that is missing, so say which
const unavailableBecause =
	parsed === undefined
		? `${path.relative(root, summaryPath)} was not written (the test step failed before coverage)`
		: `${path.relative(root, summaryPath)} is not a coverage summary`;
const baseline = await readJson<Baseline>(baselinePath);
const baselineLabel = process.env.COVERAGE_BASELINE_LABEL ?? "the base branch";
if (baseline === undefined && (await readFile(baselinePath, "utf8").catch(() => undefined)) !== undefined)
	console.warn(`${path.relative(root, baselinePath)} could not be read as a baseline, reporting without a change`);

const comment = buildComment(summary, baseline, baselineLabel, unavailableBecause);
await mkdir(path.dirname(commentPath), { recursive: true });
await writeFile(commentPath, `${comment}\n`);
console.log(`Wrote ${path.relative(root, commentPath)}${baseline === undefined ? " (no baseline, so no change column)" : ` (change from ${baselineLabel})`}`);

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
