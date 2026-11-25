import { compareVersions, type LunaInstall, type TidalInstall } from "./tidalInstall";

/**
 * Puts Luna back into the TIDAL version Squirrel is installing, from the only process that knows an update is happening:
 * TIDAL's own main process, where Luna is already loaded.
 *
 * TIDAL's updater is Electron's `autoUpdater` (`app/main/store/autoUpdate/middleware.js` inside its asar), and it
 * restarts through `quitAndInstall()`. That call applies the downloaded package and then relaunches TIDAL, and the
 * relaunch is what starts a TIDAL with no Luna in it. So Luna wraps `quitAndInstall`, keeps the apply, and holds the
 * relaunch back until a detached repair has copied this Luna into the new version's `resources`.
 *
 * This is faster and narrower than the logon task: Squirrel only checks for updates while TIDAL runs (its log shows an
 * hourly `--checkForUpdate`), so the update always happens in a session where Luna is loaded, and the copy is the Luna
 * already running rather than a release downloaded and verified again.
 *
 * Every way this can go wrong ends with TIDAL started, because a TIDAL without Luna beats no TIDAL at all.
 */

export type UpdaterLike = {
	quitAndInstall: (silent?: boolean, forceRunAfter?: boolean) => void;
};

/** One hooks per updater: two hooks of the same updater cannot both wrap it (a page reload, or the guard running twice) */
const hookedUpdaters = new WeakMap<object, () => void>();

export type HookUpdaterDeps = {
	/** Electron's `autoUpdater`, or undefined where the platform has none */
	updater?: UpdaterLike;
	/** Starts the detached repair. Not awaited: the app is about to quit */
	spawnRepair: () => void;
	log: (message: string) => void;
};

/**
 * Wraps `quitAndInstall` so an update cannot relaunch into a TIDAL that has no Luna.
 *
 * Returns an unhook, so a reload does not stack wrappers. Hooking an updater that is already hooked returns the existing
 * unhook rather than wrapping again.
 */
export const hookUpdater = ({ updater, spawnRepair, log }: HookUpdaterDeps): (() => void) => {
	if (updater === undefined || typeof updater.quitAndInstall !== "function") {
		log("[updater] no autoUpdater on this platform, leaving the update alone");
		return () => {};
	}

	const already = hookedUpdaters.get(updater);
	if (already !== undefined) return already;

	const real = updater.quitAndInstall.bind(updater);
	const hook = (silent?: boolean, forceRunAfter?: boolean) => {
		try {
			spawnRepair();
		} catch (err) {
			// Risk: a repair that cannot start must not also stop TIDAL relaunching, or the user is left with nothing
			log(`[updater] could not start the repair, letting TIDAL relaunch as it would have: ${String(err)}`);
			return real(silent, forceRunAfter);
		}
		// Risk: the caller may ask to relaunch. The repair owns the relaunch now, once Luna is back in the new version
		if (forceRunAfter) log("[updater] holding the relaunch until Luna is in the new version");
		return real(silent, false);
	};

	const unhook = () => {
		updater.quitAndInstall = real;
		hookedUpdaters.delete(updater);
	};
	updater.quitAndInstall = hook;
	hookedUpdaters.set(updater, unhook);
	return unhook;
};

export type RepairResult =
	/** Luna was put into the new version and TIDAL started */
	| { action: "injected"; version?: string; launched: true }
	/** The new version is outside what this Luna supports: started without it rather than risking a broken client */
	| { action: "skipped-incompatible"; version?: string; launched: true }
	/** The update never appeared: TIDAL was started as it is, so the user is not left with nothing */
	| { action: "timed-out"; launched: true }
	/** Injecting failed: TIDAL was started as it is, and the reason is logged */
	| { action: "failed"; reason: string; launched: true };

export type RepairDeps = {
	/** TIDAL installs, newest first */
	listInstalls: () => Promise<TidalInstall[]>;
	/** Whether the version has finished being written: Squirrel writes `app.asar` as it goes */
	written: (install: TidalInstall) => Promise<boolean>;
	/** Puts this Luna's build into that install */
	inject: (install: TidalInstall) => Promise<LunaInstall>;
	/** Whether this Luna is known to work against that TIDAL. undefined: not known, so it is not installed */
	compatible?: (install: TidalInstall) => Promise<boolean | undefined>;
	/** Starts TIDAL */
	launch: () => void;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	log: (message: string) => void;
	/** How long to wait for the new version before starting TIDAL anyway */
	timeoutMs?: number;
	/** How often to look for the new version */
	pollMs?: number;
};

const defaultTimeoutMs = 120_000; // 2 min: Squirrel took ~15 s to write a version on a real update
const defaultPollMs = 250;

/** The newest install that is not the version the update started from */
const newerThan = (installs: readonly TidalInstall[], fromVersion: string | undefined) => {
	const newest = installs[0];
	if (newest === undefined) return undefined;
	if (fromVersion === undefined || newest.version === undefined) return newest;
	// A folder that carries no version (a flatpak or /opt install) can still be the updated one
	return compareVersions(newest.version, fromVersion) > 0 ? newest : undefined;
};

/**
 * Waits for Squirrel to finish writing the new version, copies this Luna into it, then starts TIDAL.
 *
 * Always starts TIDAL on the way out, including on timeout and on failure: the app is closed by the time this runs, and
 * leaving the user with nothing is worse than leaving them with an unmodded client.
 */
export const repairAfterUpdate = async (deps: RepairDeps, fromVersion?: string): Promise<RepairResult> => {
	const timeoutMs = deps.timeoutMs ?? defaultTimeoutMs;
	const pollMs = deps.pollMs ?? defaultPollMs;
	const deadline = deps.now() + timeoutMs;

	let update: TidalInstall | undefined;
	while (deps.now() < deadline) {
		const installs = await deps.listInstalls().catch((err) => {
			deps.log(`[repair] could not list TIDAL installs: ${String(err)}`);
			return [] as TidalInstall[];
		});
		const candidate = newerThan(installs, fromVersion);
		// Risk: injecting while Squirrel is still writing would corrupt the new version, so wait for it to be complete
		if (candidate !== undefined && (await deps.written(candidate).catch(() => false))) {
			update = candidate;
			break;
		}
		await deps.sleep(pollMs);
	}

	if (update === undefined) {
		deps.log(`[repair] no new TIDAL version appeared within ${timeoutMs} ms, starting TIDAL as it is`);
		deps.launch();
		return { action: "timed-out", launched: true };
	}

	// Risk: a Luna built for the old TIDAL may not work against the new one. Patch matching says whether to install it
	const supported = await deps.compatible?.(update).catch((err) => {
		deps.log(`[repair] could not tell whether this Luna supports the new TIDAL: ${String(err)}`);
		return undefined;
	});
	if (supported !== true) {
		deps.log(`[repair] not installing this Luna into ${update.version ?? update.appDir}: support is ${supported === false ? "refused" : "unknown"}`);
		deps.launch();
		return { action: "skipped-incompatible", version: update.version, launched: true };
	}

	try {
		const installed = await deps.inject(update);
		deps.log(`[repair] put Luna ${installed.lunaVersion} into ${update.version ?? update.appDir}`);
		deps.launch();
		return { action: "injected", version: update.version, launched: true };
	} catch (err) {
		// Risk: a failed install must still leave the user a TIDAL to open
		const reason = err instanceof Error ? err.message : String(err);
		deps.log(`[repair] could not install Luna into ${update.version ?? update.appDir}, starting TIDAL as it is: ${reason}`);
		deps.launch();
		return { action: "failed", reason, launched: true };
	}
};
