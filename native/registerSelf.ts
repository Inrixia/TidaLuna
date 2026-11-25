import { stat } from "fs/promises";
import path from "path";

import { newLunaState, readLunaState, recordInstall, writeLunaState } from "./lunaState";
import { versionOfAppDir } from "./tidalInstall";

/**
 * Luna recording that it is installed, which is the one thing that lets a later repair act.
 *
 * The guard refuses to install anything on a machine with no record, because a vanilla TIDAL looks exactly like one Luna
 * was just removed from. So the record has to be written by the install doing something only an install can do: booting.
 * This runs once per start, from the injector, and is what makes every other part of this able to tell the two apart.
 *
 * It records where Luna actually is rather than where it expects to be: `resources` is the folder the running Luna was
 * loaded from, so the record always describes this install.
 */

export type SelfRecordDeps = {
	/** Luna's own folder, outside TIDAL's tree */
	stateRoot: string;
	/** The `resources` folder the running Luna was loaded from (`process.resourcesPath`) */
	resourcesDir: string;
	lunaVersion: string;
};

export type SelfRecordResult = { recorded: boolean; reason: string };

/**
 * Records this install, or says why it could not be recorded.
 *
 * Never throws: this runs on the boot path, and a machine that cannot write its own record should still start TIDAL and
 * Luna. The next start tries again.
 */
export const recordLunaInstalled = async ({ stateRoot, resourcesDir, lunaVersion }: SelfRecordDeps): Promise<SelfRecordResult> => {
	const appDir = path.dirname(resourcesDir);
	// TIDAL's asar as it is now: a later run compares this to tell whether the install changed under Luna
	const asar = await stat(path.join(resourcesDir, "original.asar")).catch(() => undefined);
	if (asar === undefined) return { recorded: false, reason: "there is no original.asar, so this is not an installed Luna" };
	if (path.basename(resourcesDir) !== "resources") return { recorded: false, reason: `${resourcesDir} is not a resources folder` };

	try {
		const state = await readLunaState(stateRoot);
		const install = {
			tidalVersion: versionOfAppDir(path.basename(appDir)),
			asarBytes: asar.size,
			asarMtimeMs: asar.mtimeMs,
			injectedAt: new Date().toISOString(),
			lunaVersion,
		};
		const recorded = recordInstall(state ?? newLunaState(lunaVersion), resourcesDir, install);
		// A record that is already current is not rewritten: the point is to know the install is there, not to touch the
		// disk on every start
		const existing = state?.installs[resourcesDir];
		if (
			existing !== undefined &&
			existing.asarBytes === install.asarBytes &&
			existing.asarMtimeMs === install.asarMtimeMs &&
			existing.lunaVersion === lunaVersion
		) {
			return { recorded: true, reason: "already recorded for this install" };
		}
		await writeLunaState(stateRoot, recorded);
		return { recorded: true, reason: "recorded" };
	} catch (err) {
		return { recorded: false, reason: `could not write the record: ${(err as Error).message}` };
	}
};
