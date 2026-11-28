import { readFile } from "fs/promises";
import path from "path";

import { readLunaState } from "./lunaState";

/**
 * What the settings page shows about the unattended run.
 *
 * Read-only on purpose. The page can see whether Luna is installed for the TIDAL that is running and what the last run
 * decided, but it cannot start one: an install from page code is exactly what #292 puts behind a confirmation window, and
 * a button here would be a way around it. When that window lands, a repair action can be added behind it.
 */

export type LastRun = { at: string; action: "installed" | "none" | "refused" | "failed" | string; reason: string };

export type UpdateGuardStatus = {
	/** Luna's own folder, which is what says Luna was installed here at all */
	stateRoot: string;
	/** Undefined when Luna has no record of being installed, so nothing will be done on this machine */
	installed?: { lunaVersion: string; autoUpgrade: boolean; pinnedVersion?: string; installs: string[] };
	/** The newest line of the run log, undefined if it has never run */
	lastRun?: LastRun;
	/** The last few runs, oldest first, for when the one-line answer is not enough */
	recent: LastRun[];
};

const LOG_LIMIT = 20;

/** `<iso> <action>: <reason>`, as `autoUpdate.ts` writes it */
export const parseRunLog = (log: string): LastRun[] =>
	log
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const match = /^(\S+) ([a-z]+): (.*)$/.exec(line);
			// A line that does not parse is still shown, rather than the whole log being dropped for one bad line
			return match === null ? { at: "", action: "unreadable", reason: line } : { at: match[1], action: match[2], reason: match[3] };
		});

/**
 * @param stateRoot Luna's own folder
 */
export const updateGuardStatus = async (stateRoot: string): Promise<UpdateGuardStatus> => {
	const state = await readLunaState(stateRoot);
	const log = await readFile(path.join(stateRoot, "log", "update-guard.log"), "utf8").catch(() => "");
	const runs = parseRunLog(log);

	return {
		stateRoot,
		installed:
			state === undefined
				? undefined
				: {
						lunaVersion: state.lunaVersion,
						autoUpgrade: state.autoUpgrade,
						pinnedVersion: state.pinnedVersion,
						installs: Object.keys(state.installs),
					},
		lastRun: runs[runs.length - 1],
		recent: runs.slice(-LOG_LIMIT),
	};
};
