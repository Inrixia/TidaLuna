import type { LunaState } from "./lunaState";
import type { InjectionState, TidalInstall } from "./tidalInstall";

/**
 * What to do about a TIDAL install, given what is in it and whether Luna has ever been installed here.
 *
 * Pure on purpose: this is the decision an unattended run makes, so every branch is a case worth being able to reason
 * about and test without a file system. Two rules shape all of it:
 *
 * - Without a state saying the user wanted Luna, nothing is installed. A vanilla TIDAL is far more likely to be someone
 *   who never installed Luna than someone whose Luna an update just removed, and guessing wrong means installing a client
 *   mod on a machine that did not ask for one.
 * - The comparison is on TIDAL's asar, not only on version strings: size and mtime prove the install changed even where
 *   nothing in the path carries a version (a flatpak or /opt install), which is the case a version compare misses.
 */

/** One TIDAL install, what is in it, and the asar TIDAL has there now */
export type Observation = {
	install: TidalInstall;
	injection: InjectionState;
	/** The asar in the install right now, compared against what the marker recorded at install time */
	currentAsar?: { bytes: number; mtimeMs: number };
};

export type UpdatePlan =
	/** Nothing to do. The reason is logged, and is the only record of why an unattended run did nothing */
	| { action: "none"; reason: string }
	/** Put Luna into this install */
	| { action: "inject"; install: TidalInstall; reason: string };

const none = (reason: string): UpdatePlan => ({ action: "none", reason });
const inject = (install: TidalInstall, reason: string): UpdatePlan => ({ action: "inject", install, reason });

/**
 * @param state Luna's own record, undefined when Luna has never been installed here
 * @param observations TIDAL installs, newest first
 */
export const planUpdate = (state: LunaState | undefined, observations: Observation[]): UpdatePlan => {
	const newest = observations[0];
	if (newest === undefined) return none("no TIDAL install found");
	// The one rule that keeps this from installing a client mod uninvited
	if (state === undefined) return none("Luna has no record of being installed here, so nothing was done");

	const { install, injection, currentAsar } = newest;
	const where = install.version === undefined ? "the newest TIDAL install" : `TIDAL ${install.version}`;

	switch (injection.kind) {
		case "empty":
			return none(`${where} holds neither an asar nor an app, so it is not a usable TIDAL install`);
		case "foreign":
			// Someone else's app folder, or a dev symlink: not ours to replace
			return none(`${where}: ${injection.reason}`);
		case "vanilla":
			return inject(install, `${where} has no Luna in it`);
		case "injected": {
			const recorded = injection.install;
			if (currentAsar === undefined) return inject(install, `${where}: Luna is installed but TIDAL's asar is missing`);
			const changed = currentAsar.bytes !== recorded.asarBytes || currentAsar.mtimeMs !== recorded.asarMtimeMs;
			// Version strings are for the log: the asar is what actually says the install changed
			if (changed) {
				const from = recorded.tidalVersion === undefined ? "an earlier TIDAL" : `TIDAL ${recorded.tidalVersion}`;
				return inject(install, `${where}: TIDAL's asar changed since Luna was installed next to ${from}`);
			}
			return none(`${where} already has Luna ${recorded.lunaVersion} for this install`);
		}
	}
};
