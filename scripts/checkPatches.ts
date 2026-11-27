/**
 * Checks every `tidalPatches` entry against the TIDAL sources a test instance dumped, and names the ones whose fix is
 * no longer being applied. `applyTidalPatches` skips a patch it cannot match without logging anything, so without this
 * a TIDAL update quietly drops Luna's perf fixes.
 *
 *   node .claude/skills/tidal-test-instance/tidal.mjs dump     # writes .tidal-test/<n>/sources
 *   pnpm exec tsx scripts/checkPatches.ts [dir]
 *
 * Exits 1 when a patch that used to apply no longer does, 2 when there is no dump to check. No instance needed while it
 * runs, no network, no login, and nothing to interpret: the verdict is a comparison.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { checkPatches } from "../render/src/tidalPatchCheck";

const dir = resolve(process.argv[2] ?? ".tidal-test/1/sources");

const files = await readdir(dir, { recursive: true }).catch(() => {
	console.error(`No dump at ${dir}\nDump one with: node .claude/skills/tidal-test-instance/tidal.mjs dump`);
	process.exit(2);
});
// Only the renderer modules are patched; sibling folders (native) are read anyway and simply match nothing
const sources = (await Promise.all(files.map((name) => readFile(join(dir, String(name)), "utf8").catch(() => undefined)))).filter(
	(source): source is string => source !== undefined,
);

const results = checkPatches(sources);
const width = Math.max(...results.map(({ name }) => name.length));
for (const { name, state, sources: count } of results) {
	// "absent" is not a failure: a dump only has the modules the pages that were opened load
	const note = state === "absent" ? "  (no module has its marker: page not opened, or TIDAL renamed it)" : "";
	console.log(`${state.padEnd(7)} ${name.padEnd(width)}  ${count} module${count === 1 ? "" : "s"}${note}`);
}

const broken = results.filter(({ state }) => state === "stale" || state === "noop");
console.log(`\n${sources.length} sources read, ${results.length - broken.length}/${results.length} patches apply`);
if (broken.length > 0) {
	console.error(`\nNOT APPLIED: ${broken.map(({ name, state }) => `${name} (${state})`).join(", ")}`);
	process.exitCode = 1;
}
