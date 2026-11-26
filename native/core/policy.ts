// Pure decisions about Luna's own native code, kept apart so they can be tested without Electron.
import semverParse from "semver/functions/parse";

export type CoreNativeRule = "allow" | "deny" | "confirm";
// Core native exports page code may not call, or only after the user confirms in Luna's confirmation window
// (confirmWindow.ts). Everything else a core plugin exports is meant for the page (pkg, dialogs, caches, download into
// picked folders, …). runElevatedInstall only installs the build the user confirmed in `update`, and pkexec asks for the
// password itself: asking again would refuse it when the download took longer than the user's last click counts
const coreDenied = new Set(["sendToRender"]);
const coreConfirmed = new Set(["update", "startNativeDebugging"]);
export const coreNativeRule = (exportName: string): CoreNativeRule =>
	coreDenied.has(exportName) ? "deny" : coreConfirmed.has(exportName) ? "confirm" : "allow";

/** A release tag `update` can download (the same check as native/update.ts): no "/" or ".." to point it at another repo */
export const isReleaseVersion = (version: unknown): version is string =>
	typeof version === "string" && /^[\w.-]+$/.test(version) && !version.includes("..");

/**
 * Why a confirmed core native's arguments would make it fail, checked before the user is asked: the window must not show
 * text that page code chose for a call that can't run. Undefined if they are fine
 */
export const coreNativeArgsError = (exportName: string, args: unknown[]): string | undefined => {
	if (exportName === "update" && !isReleaseVersion(args[0])) return `update: invalid version "${String(args[0]).slice(0, 40)}"`;
	return undefined;
};

/**
 * Compares two release versions like "1.25.0" or "1.25.0-beta" by semver: negative if `a` is older, 0 if the same,
 * positive if newer. A pre-release is older than its release. A tag that isn't a version at all (`isReleaseVersion`
 * only checks it can't point anywhere else) compares as 0, so nothing is claimed about it.
 */
export const compareVersions = (a: string, b: string): number => {
	const left = semverParse(a, { loose: true });
	const right = semverParse(b, { loose: true });
	return left === null || right === null ? 0 : left.compare(right);
};

/**
 * What the confirmation window says before a confirmed core native runs
 *
 * @param current Luna's installed version, shown next to the one an update installs
 */
export const coreNativeQuestion = (
	exportName: string,
	args: unknown[],
	current?: string,
): [title: string, lines: string[], confirmText: string] => {
	switch (exportName) {
		case "update": {
			const target = String(args[0]);
			const lines = [`Download and install Luna ${target}, then restart TIDAL.`];
			if (current !== undefined) {
				lines.push(`Installed now: ${current} -> ${target}.`);
				if (compareVersions(target, current) < 0) lines.push(`${target} is older than the installed version.`);
			}
			return ["Update Luna?", lines, "Update"];
		}
		case "startNativeDebugging":
			return [
				"Start native debugging?",
				[
					"Opens a Node inspector on TIDAL's main process, on this computer only (127.0.0.1, usually port 9229).",
					"It stays open until TIDAL is restarted. Any program on this computer can use it to run code in TIDAL.",
				],
				"Start",
			];
		default:
			return [`Run ${exportName}?`, [], "Run"];
	}
};
