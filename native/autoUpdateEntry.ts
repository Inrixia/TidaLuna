import { execFile } from "child_process";
import os from "os";
import { promisify } from "util";

import { runAutoUpdate } from "./autoUpdate";

/**
 * The entry point the schedule calls: one run, then exit.
 *
 * It is bundled to `dist/autoUpdate.mjs` and started by a generated wrapper with `ELECTRON_RUN_AS_NODE=1`, so it runs on
 * TIDAL's own Electron binary and needs nothing installed besides TIDAL and Luna. Deliberately no `electron` import: this
 * process is Node, not an Electron app, and touching the Electron API here would fail.
 *
 * It exits non-zero when the run failed, so a schedule can record the failure, and zero when it did nothing, which is the
 * normal case.
 */

const execFileAsync = promisify(execFile);

const run = async (command: string, args: string[]): Promise<string> => {
	const { stdout } = await execFileAsync(command, args);
	return stdout;
};

/** Whether this process is started by the schedule rather than imported, so importing it in a test runs nothing */
const isEntryPoint = (): boolean => {
	const entry = process.argv[1];
	// esbuild keeps `import.meta.url` in the bundle; a schedule run has no test runner in argv
	return entry !== undefined && !entry.includes("vitest") && !entry.includes("node_modules");
};

const main = async () => {
	// Started by the updater hook rather than by the schedule: TIDAL is closing, so wait for the version it is installing
	// and put this Luna into it, then start the app the update was told not to relaunch (see updaterHook.ts)
	const afterUpdate = process.argv.indexOf("--after-update");
	if (afterUpdate !== -1) {
		const { runRepair } = await import("./repairRun");
		const { fileURLToPath } = await import("url");
		const { dirname } = await import("path");
		const outcome = await runRepair({
			distDir: dirname(fileURLToPath(import.meta.url)),
			fromVersion: process.argv[afterUpdate + 1] || undefined,
			lunaVersion: process.argv[afterUpdate + 2] || "unknown",
		});
		console.log(`[Luna] after update: ${outcome.action}`);
		return;
	}

	const outcome = await runAutoUpdate({
		platform: { platform: process.platform, env: process.env, home: os.homedir() },
		httpFetch: fetch,
		run,
	});
	// The outcome is already in the log; stdout is for whoever ran it by hand
	console.log(`[Luna] ${outcome.action}: ${outcome.reason}`);
	if (outcome.action === "failed") process.exitCode = 1;
	// A refused run is not an error: it usually means TIDAL is open, and the next logon tries again
};

if (isEntryPoint()) {
	main().catch((err) => {
		console.error(`[Luna] the update check failed: ${(err as Error).message}`);
		process.exitCode = 1;
	});
}
