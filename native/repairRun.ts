import { spawn } from "child_process";
import { stat } from "fs/promises";
import os from "os";
import path from "path";

import { compareVersions, defaultTidalRoots, findTidalInstalls, injectLuna, type TidalInstall } from "./tidalInstall";
import { repairAfterUpdate, type RepairResult } from "./updaterHook";

/**
 * The detached half of the updater hook: the process Luna spawns when TIDAL is about to apply an update.
 *
 * It runs on TIDAL's own Electron binary with `ELECTRON_RUN_AS_NODE=1` (bundled to `dist/autoUpdate.mjs`), so it is
 * Node, not Electron, and must not import `electron`. It waits for Squirrel to finish writing the new version, copies
 * the Luna already in `dist` into it, and starts TIDAL, which `quitAndInstall` was told not to do.
 */
export type RepairRunDeps = {
	/** The bundle folder this Luna runs from, which is what gets copied into the new version */
	distDir: string;
	lunaVersion: string;
	/** The TIDAL version the update started from, so only a newer install is written to */
	fromVersion?: string;
	platform?: NodeJS.Platform;
	home?: string;
	env?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
	/** Installs a release that fits the new TIDAL when this build does not. See RepairDeps.escalate */
	escalate?: () => Promise<boolean>;
	timeoutMs?: number;
};

const exeIn = (install: TidalInstall, platform: NodeJS.Platform) =>
	platform === "win32" ? path.join(install.appDir, "TIDAL.exe") : path.join(install.appDir, "tidal-hifi");

/** Starts that install, so the user is never left with TIDAL closed */
export const launchInstall = (install: TidalInstall | undefined, platform: NodeJS.Platform) => {
	if (install === undefined) return;
	const exe = exeIn(install, platform);
	try {
		spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
	} catch {
		// Nothing better to do here: the log line from the caller says the install went where it went
	}
};

export const runRepair = async (deps: RepairRunDeps): Promise<RepairResult> => {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const home = deps.home ?? os.homedir();
	const log = deps.log ?? ((message: string) => console.log(`[Luna] ${message}`));

	let newest: TidalInstall | undefined;
	const listInstalls = async () => {
		const installs = await findTidalInstalls(defaultTidalRoots(env, platform, home));
		newest = installs[0];
		return installs;
	};

	// Squirrel writes a version's files over several seconds, so a version counts as written only once its asar is
	// there and its size has stopped changing between two looks
	const sizes = new Map<string, number>();
	const written = async (install: TidalInstall) => {
		const asar = path.join(install.resourcesDir, "app.asar");
		const size = await stat(asar).then(
			(found) => found.size,
			() => 0,
		);
		if (size <= 0) return false;
		const before = sizes.get(install.appDir);
		sizes.set(install.appDir, size);
		return before === size;
	};

	return repairAfterUpdate(
		{
			listInstalls,
			written,
			inject: (install) => injectLuna(install.resourcesDir, deps.distDir, { lunaVersion: deps.lunaVersion, tidalVersion: install.version }),
			// The build that is running was made for the TIDAL it is running in. A bump inside the same major version is
			// treated as compatible; anything else is unknown, and unknown means it is not installed.
			compatible: async (install) =>
				deps.fromVersion === undefined || install.version === undefined
					? undefined
					: compareVersions(deps.fromVersion, install.version) > 0
						? undefined
						: deps.fromVersion.split(".")[0] === install.version.split(".")[0],
			launch: () => launchInstall(newest, platform),
			escalate: deps.escalate,
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			now: () => Date.now(),
			log,
			timeoutMs: deps.timeoutMs,
		},
		deps.fromVersion,
	);
};
