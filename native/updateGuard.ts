import { rename, rm, stat } from "fs/promises";
import path from "path";

import { forgetLunaState, readLunaState, recordInstall, writeLunaState, type LunaState } from "./lunaState";
import { verifyLunaZip } from "./releaseGate";
import { resolveRelease, type Resolution } from "./releaseResolver";
import { findTidalInstalls, injectLuna, injectionState, type TidalRoot } from "./tidalInstall";
import { planUpdate, type Observation, type UpdatePlan } from "./updatePlan";
import { extractZipEntries } from "./zipEntries";

import type { ReleaseInfo } from "./releaseGate";

/**
 * The run that puts Luna back after TIDAL updated.
 *
 * It does work only when Luna has a record of being installed and that record is not current, so a machine that never had
 * Luna is left alone and a current install costs nothing. The roots, the network and the process check are passed in, so
 * the decision and its order are testable without TIDAL, a release or an archive.
 *
 * Nothing is written into TIDAL's tree until the archive is verified and unpacked elsewhere. A bad download costs a
 * failed run, not a broken client.
 */

export type GuardDeps = {
	/** Where TIDAL may be installed */
	roots: TidalRoot[];
	/** Luna's own folder, outside TIDAL's tree: the state, and the verified build kept for repairs */
	stateRoot: string;
	fetchReleases: () => Promise<ReleaseInfo[]>;
	fetchCompat: (release: ReleaseInfo) => Promise<unknown | string>;
	fetchZip: (url: string) => Promise<Uint8Array>;
	/**
	 * Removes the schedule that starts a run, used when the user has removed Luna and it must not be put back. Supplied
	 * by the caller, which owns the platform detail the schedule needs
	 */
	unregisterSchedule?: () => Promise<unknown>;
	/** A run refuses while TIDAL is open: writing into a live install corrupts it */
	isTidalRunning?: () => Promise<boolean>;
	/**
	 * Whether the running Luna found TIDAL's code no longer matches its patches (see render/src/patchReport.ts). It
	 * decides whether the same version repairs the install or a newer one is needed.
	 */
	patchesStale?: () => Promise<boolean>;
	/** Whether the user opted into prereleases */
	allowPrerelease?: boolean;
	now?: () => string;
};

export type GuardOutcome = {
	action: "none" | "installed" | "refused" | "failed" | "forgotten";
	/** One line, for the log and the settings card */
	reason: string;
	/** What it did and why, in order */
	notes: string[];
	installed?: { version: string; resourcesDir: string };
};

const outcome = (action: GuardOutcome["action"], reason: string, notes: string[] = [], extra: Partial<GuardOutcome> = {}): GuardOutcome => ({
	action,
	reason,
	notes,
	...extra,
});

/** The build directory a run installs from and leaves behind for the next repair */
const buildDir = (deps: GuardDeps) => path.join(deps.stateRoot, "build");
const stagedDir = (deps: GuardDeps) => path.join(deps.stateRoot, "build.new");

const observe = async (install: Awaited<ReturnType<typeof findTidalInstalls>>[number]): Promise<Observation> => {
	const injection = await injectionState(install.resourcesDir);
	// The asar TIDAL has now, which is what says whether the install changed under Luna
	const asar = await stat(path.join(install.resourcesDir, "original.asar")).catch(() => undefined);
	return { install, injection, currentAsar: asar === undefined ? undefined : { bytes: asar.size, mtimeMs: asar.mtimeMs } };
};

const planOf = (state: LunaState | undefined, observation: Observation): UpdatePlan => planUpdate(state, [observation]);

export const runUpdateGuard = async (deps: GuardDeps): Promise<GuardOutcome> => {
	const notes: string[] = [];
	const now = deps.now ?? (() => new Date().toISOString());

	// Local first: most runs end here, and neither of the cheap answers should touch the network
	const installs = await findTidalInstalls(deps.roots);
	const newest = installs[0];
	if (newest === undefined) return outcome("none", "no TIDAL install found", notes);

	const state = await readLunaState(deps.stateRoot);
	const observation = await observe(newest);
	const plan = planOf(state, observation);
	notes.push(plan.reason);
	if (plan.action === "none") return outcome("none", plan.reason, notes);
	if (plan.action === "forget") {
		// The user removed Luna. Forget it before unregistering: a state file that is already gone cannot make a later run
		// put Luna back, so a failed unregister is the lesser problem
		await forgetLunaState(deps.stateRoot).catch((err) => notes.push(`could not forget the install record: ${String(err)}`));
		await deps.unregisterSchedule?.().catch((err) => notes.push(`could not remove the update check: ${String(err)}`));
		return outcome("forgotten", plan.reason, notes);
	}
	if (state === undefined) return outcome("none", "Luna has no record of being installed here", notes);

	if ((await deps.isTidalRunning?.()) === true) return outcome("refused", "TIDAL is running, so its files are left alone until it closes", notes);

	let resolution: Resolution;
	try {
		resolution = await resolveRelease(await deps.fetchReleases(), {
			tidalVersion: newest.version,
			pinnedVersion: state.pinnedVersion,
			allowPrerelease: deps.allowPrerelease ?? false,
			fetchCompat: deps.fetchCompat,
		});
	} catch (err) {
		return outcome("failed", `could not read the releases: ${(err as Error).message}`, notes);
	}
	notes.push(...resolution.notes);
	if (!resolution.ok) return outcome("refused", resolution.reason, notes);
	const { candidate } = resolution;
	notes.push(`picked ${candidate.version} (${resolution.verdict})`);

	// The same version that is already installed is not a repair when its patches stopped matching: TIDAL moved and this
	// Luna cannot be made to fit it by reinstalling. Saying so is better than a run that appears to fix nothing
	const installedVersion = observation.injection.kind === "injected" ? observation.injection.install.lunaVersion : undefined;
	if (state.pinnedVersion === undefined && installedVersion !== undefined && candidate.version === installedVersion) {
		if ((await deps.patchesStale?.()) === true) {
			return outcome("refused", `${candidate.version} is installed but no longer matches this TIDAL, and no newer release is available`, notes);
		}
	}

	// Download and verify before anything in TIDAL's tree is touched
	let zip: Uint8Array;
	try {
		zip = await deps.fetchZip(candidate.url);
		await verifyLunaZip(zip, { version: candidate.version, sha256: candidate.sha256 });
	} catch (err) {
		return outcome("failed", `the download was refused: ${(err as Error).message}`, notes);
	}

	// Unpacked outside TIDAL's tree, so a refusal here leaves the install exactly as it was
	const staged = stagedDir(deps);
	const build = buildDir(deps);
	await rm(staged, { recursive: true, force: true });
	try {
		await extractZipEntries(zip, staged);
	} catch (err) {
		await rm(staged, { recursive: true, force: true }).catch(() => {});
		return outcome("failed", `the archive could not be unpacked: ${(err as Error).message}`, notes);
	}

	let installed: Awaited<ReturnType<typeof injectLuna>>;
	try {
		installed = await injectLuna(newest.resourcesDir, staged, { lunaVersion: candidate.version, tidalVersion: newest.version });
	} catch (err) {
		await rm(staged, { recursive: true, force: true }).catch(() => {});
		return outcome("failed", `installing into TIDAL failed: ${(err as Error).message}`, notes);
	}

	// Keep the verified build outside TIDAL's tree: the next repair installs from it if the network is gone
	await rm(build, { recursive: true, force: true }).catch(() => {});
	await rename(staged, build).catch(() => {});
	await writeLunaState(
		deps.stateRoot,
		recordInstall(state, newest.resourcesDir, {
			tidalVersion: newest.version,
			asarBytes: installed.asarBytes,
			asarMtimeMs: installed.asarMtimeMs,
			injectedAt: installed.injectedAt,
			lunaVersion: candidate.version,
		}),
	);
	notes.push(`installed Luna ${candidate.version} into ${newest.resourcesDir}`);
	return outcome("installed", `Luna ${candidate.version} installed for TIDAL ${newest.version ?? "unknown"}`, notes, {
		installed: { version: candidate.version, resourcesDir: newest.resourcesDir },
	});
};
