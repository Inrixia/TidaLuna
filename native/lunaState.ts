import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

/**
 * Luna's own record of having been installed, kept outside TIDAL's tree.
 *
 * Without it there is no way to tell a TIDAL update that replaced Luna from a machine that never had Luna: both are a
 * vanilla `resources` folder. That distinction is the whole reason an automatic repair is allowed to act, and the reason
 * it must not act when this folder is absent. TIDAL's own uninstall and update may clear anything under its profile, so
 * this lives in a folder of Luna's own.
 */

export const LUNA_STATE_FILE = "state.json";

export type RecordedInstall = {
	/** TIDAL's version this Luna was installed into, when it could be read */
	tidalVersion?: string;
	/** TIDAL's asar this was installed next to, by size and mtime */
	asarBytes: number;
	asarMtimeMs: number;
	injectedAt: string;
	lunaVersion: string;
};

export type LunaState = {
	/** When Luna first recorded itself here */
	installedAt: string;
	/** Version of the dist last put into a TIDAL install */
	lunaVersion: string;
	/** A version the user pinned: automatic upgrades then never move off it */
	pinnedVersion?: string;
	/** Whether an automatic repair may also upgrade, or should only ever reinstall `lunaVersion` */
	autoUpgrade: boolean;
	/** The installs Luna has recorded, by TIDAL resources folder */
	installs: Record<string, RecordedInstall>;
	/** How the run that puts Luna back is started, once Luna has registered it. Absent: not registered */
	schedule?: { mechanism: string; installedAt: string };
	/**
	 * What the user answered when asked whether Luna may keep itself installed after a TIDAL update. Undefined until
	 * asked, and only `enabled` ever registers anything: this is opt-in, so silence must not be read as yes.
	 */
	updateRecovery?: "enabled" | "declined";
};

export const newLunaState = (lunaVersion: string, now = new Date().toISOString()): LunaState => ({
	installedAt: now,
	lunaVersion,
	autoUpgrade: true,
	installs: {},
});

const stateFile = (rootDir: string) => path.join(rootDir, LUNA_STATE_FILE);

/**
 * The recorded state, or undefined when Luna has never installed itself here (or the file is unusable, which is treated
 * the same way: nothing is acted on without a state that says the user wanted Luna).
 */
export const readLunaState = async (rootDir: string): Promise<LunaState | undefined> => {
	const raw = await readFile(stateFile(rootDir), "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.installedAt !== "string" || typeof parsed.lunaVersion !== "string") return undefined;
		return {
			...newLunaState(parsed.lunaVersion, parsed.installedAt),
			...parsed,
			// A state written by an older build may lack these
			autoUpgrade: parsed.autoUpgrade !== false,
			installs: typeof parsed.installs === "object" && parsed.installs !== null ? parsed.installs : {},
		};
	} catch {
		return undefined;
	}
};

export const writeLunaState = async (rootDir: string, state: LunaState): Promise<void> => {
	await mkdir(rootDir, { recursive: true });
	await writeFile(stateFile(rootDir), JSON.stringify(state, null, "\t"));
};

/** Removes the record, for an uninstall: the next TIDAL update then leaves Luna alone */
export const forgetLunaState = async (rootDir: string): Promise<void> => {
	await rm(stateFile(rootDir), { force: true });
};

/** Records a completed install, keeping the state's own bookkeeping in one place */
export const recordInstall = (state: LunaState, resourcesDir: string, install: RecordedInstall): LunaState => ({
	...state,
	lunaVersion: install.lunaVersion,
	installs: { ...state.installs, [resourcesDir]: install },
});
