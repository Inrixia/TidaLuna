import { appendFile, mkdir } from "fs/promises";
import os from "os";
import path from "path";

import { remoteCompat } from "./releaseResolver";
import type { ReleaseInfo } from "./releaseGate";
import { removeSchedule } from "./installSchedule";
import { runUpdateGuard, type GuardOutcome } from "./updateGuard";
import { defaultTidalRoots, type TidalRoot } from "./tidalInstall";

/**
 * The unattended run, wired to the real world.
 *
 * Everything it touches — where Luna keeps its own files, GitHub, whether TIDAL is running — is a plain function here, so
 * the wiring is testable without a network or a client, and `updateGuard`'s decision stays separate from it.
 *
 * It runs when TIDAL is not, which means nobody is watching: every run writes its outcome to a log under Luna's own
 * folder, so "it did nothing" is answerable afterwards.
 */

const RELEASES_URL = "https://api.github.com/repos/Inrixia/TidaLuna/releases";
/** A release zip is a few MB; this is the point past which a download is not a Luna build but a mistake */
const MAX_ZIP_BYTES = 128 * 1024 ** 2;

export type Platform = {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	home: string;
};

/**
 * Luna's own folder, deliberately outside TIDAL's tree.
 *
 * TIDAL's uninstall and its updater may clear anything under its own profile, and this folder is what says Luna was
 * installed here at all — losing it would make a repair impossible to justify.
 *
 * @param override what a caller wants instead, e.g. a test or a portable install
 */
export const stateRootFor = ({ platform, env, home }: Platform, override?: string): string => {
	if (override !== undefined) return override;
	if (platform === "win32" && env.LOCALAPPDATA !== undefined) return path.join(env.LOCALAPPDATA, "luna");
	if (platform === "darwin") return path.join(home, "Library", "Application Support", "luna");
	return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "tidaluna");
};

/** Reads bytes with a ceiling, so a wrong url cannot be turned into a full disk */
const readCapped = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
	const declared = Number(response.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`the download is ${declared} bytes, over the ${maxBytes} allowed`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length > maxBytes) throw new Error(`the download is ${bytes.length} bytes, over the ${maxBytes} allowed`);
	return bytes;
};

/** The published releases, drafts included so `releaseRejection` is the one that decides what may be installed */
export const readReleases = async (httpFetch: typeof fetch, url = RELEASES_URL): Promise<ReleaseInfo[]> => {
	const response = await httpFetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "TidaLuna" } });
	if (!response.ok) {
		// Told apart because an unauthenticated GitHub is rate limited to 60 an hour, which is worth the reader knowing
		const limited = response.status === 403 || response.status === 429;
		throw new Error(`releases could not be read: ${response.status} ${response.statusText}${limited ? " (GitHub rate limit)" : ""}`);
	}
	const body = await response.json();
	if (!Array.isArray(body)) throw new Error("releases were not a list");
	return <ReleaseInfo[]>body;
};

export const downloadZip = async (httpFetch: typeof fetch, url: string): Promise<Uint8Array> => {
	const response = await httpFetch(url);
	if (!response.ok) throw new Error(`the download failed: ${response.status} ${response.statusText}`);
	return readCapped(response, MAX_ZIP_BYTES);
};

/** Whether TIDAL is running, so a run can leave its files alone until it closes */
export const tidalRunning = async (run: (command: string, args: string[]) => Promise<string>, platform: NodeJS.Platform): Promise<boolean> => {
	if (platform === "win32") {
		const output = await run("tasklist", ["/FI", "IMAGENAME eq TIDAL.exe", "/NH"]).catch(() => "");
		return /tidal\.exe/i.test(output);
	}
	// pgrep exits non-zero when nothing matches, which `run` turns into a throw: nothing running
	return run("pgrep", ["-f", "^/opt/tidal-hifi|tidal-hifi"])
		.then((output) => output.trim() !== "")
		.catch(() => false);
};

export type AutoUpdateDeps = {
	platform: Platform;
	httpFetch: typeof fetch;
	run: (command: string, args: string[]) => Promise<string>;
	/** Where Luna keeps its own files; defaults to `stateRootFor(platform)` */
	stateRoot?: string;
	/** Where TIDAL may be installed; defaults to what the platform implies. A caller that knows better (a portable
	 * install, a test) says so rather than the guess being widened */
	roots?: TidalRoot[];
	/** Whether the user opted into prereleases */
	allowPrerelease?: boolean;
	/** Whether the running Luna found TIDAL's patches stale, when that is known (see render/src/patchReport.ts) */
	patchesStale?: () => Promise<boolean>;
	now?: Date;
};

/** One line per run, so a run nobody watched can still be explained */
const logOutcome = async (stateRoot: string, outcome: GuardOutcome, now: Date) => {
	const logDir = path.join(stateRoot, "log");
	await mkdir(logDir, { recursive: true });
	const line = `${now.toISOString()} ${outcome.action}: ${outcome.reason}\n`;
	await appendFile(path.join(logDir, "update-guard.log"), line);
};

/**
 * Runs the guard against the real file system, GitHub and process list.
 *
 * Nothing here is reachable from the page: it takes no arguments from a renderer and is called by the main process on its
 * own schedule, so a page cannot ask for an install. That is why #292 puts the page's `update` behind a confirmation.
 */
export const runAutoUpdate = async (deps: AutoUpdateDeps): Promise<GuardOutcome> => {
	const { platform, httpFetch, run } = deps;
	const stateRoot = stateRootFor(platform, deps.stateRoot);
	const now = deps.now ?? new Date();

	const outcome = await runUpdateGuard({
		roots: deps.roots ?? defaultTidalRoots(platform.env, platform.platform, platform.home),
		stateRoot,
		// A run that finds Luna removed stops putting it back, and has to stop starting itself too
		unregisterSchedule: () =>
			removeSchedule({
				platform: platform.platform,
				home: platform.home,
				// The schedule's runner reports an exit code; this one throws, so it is adapted rather than swapped out
				run: async (command, args) => {
					try {
						return { code: 0, stdout: await run(command, args) };
					} catch {
						return undefined;
					}
				},
			}),
		fetchReleases: () => readReleases(httpFetch),
		fetchCompat: remoteCompat(httpFetch),
		fetchZip: (url) => downloadZip(httpFetch, url),
		isTidalRunning: () => tidalRunning(run, platform.platform),
		allowPrerelease: deps.allowPrerelease,
		patchesStale: deps.patchesStale,
		now: () => now.toISOString(),
	});

	// A run that failed is the one worth reading later, but every run is written: "why did nothing happen" is a question
	// about the quiet ones too
	await logOutcome(stateRoot, outcome, now).catch(() => {});
	return outcome;
};
