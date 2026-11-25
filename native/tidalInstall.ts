import { copyFile, cp, lstat, readdir, readFile, realpath, rename, rm, stat, writeFile } from "fs/promises";
import path from "path";

import { isInside } from "./isInside";

/**
 * Finding TIDAL's install folders and putting Luna into one.
 *
 * TIDAL's Windows install is Squirrel: `%LOCALAPPDATA%\TIDAL` holds one `app-<version>` folder per release and the
 * launcher runs the newest, so a TIDAL update adds a vanilla folder beside the one Luna is in rather than overwriting it.
 * That is what makes a repair possible at all, and why every path here is "newest first" rather than "the install".
 *
 * The three mutations of an install are the ones the installer has always done: TIDAL's `app.asar` is kept as
 * `original.asar` (the asar `native/injector.ts` boots), `resources/app` is Luna, and `app.asar` is removed so nothing
 * shadows it.
 */

/** Written into `resources/app` by an inject, so a later run knows which Luna sits next to which TIDAL build */
export const INSTALL_MARKER = ".luna-install.json";

export type LunaInstall = {
	lunaVersion: string;
	/** Version of the TIDAL this Luna was installed into, when it could be read */
	tidalVersion?: string;
	/** TIDAL's asar by size and mtime: hashing a few hundred MB on every check is not worth it */
	asarBytes: number;
	asarMtimeMs: number;
	injectedAt: string;
};

/** A folder that holds a TIDAL app: `.../TIDAL/app-2.48.0` or `/opt/tidal-hifi` */
export type TidalInstall = {
	/** The folder holding `resources/`, which is what an install mutates */
	appDir: string;
	resourcesDir: string;
	/** From the folder name (`app-2.48.0`), undefined when the path does not carry one */
	version?: string;
};

/** What Luna finds in a `resources` folder */
export type InjectionState =
	| { kind: "injected"; install: LunaInstall }
	/** `resources/app` exists but is not a Luna we installed: another Luna, a dev symlink, or a leftover */
	| { kind: "foreign"; reason: string }
	/** Nothing injected. `hasAsar` false means the folder is not a usable TIDAL install */
	| { kind: "vanilla"; hasAsar: boolean }
	/** Nothing at all: no asar, no app. Never write into this */
	| { kind: "empty" };

/** A location TIDAL may be installed at, and whether it holds `app-<version>` folders */
export type TidalRoot = { dir: string; versioned: boolean };

const isFile = (target: string) =>
	lstat(target).then(
		(info) => info.isFile(),
		() => false,
	);
const isDir = (target: string) =>
	lstat(target).then(
		(info) => info.isDirectory(),
		() => false,
	);

/** `app-2.48.0` -> `2.48.0`. Undefined for anything else, so an odd folder is skipped rather than guessed at */
export const versionOfAppDir = (name: string): string | undefined => {
	if (!name.startsWith("app-")) return undefined;
	const version = name.slice("app-".length);
	return /^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/.test(version) ? version : undefined;
};

/**
 * Orders two version strings by their numeric segments, newest last: `2.48.0` > `2.47.9`, `2.48.0` > `2.48.0-beta`.
 * Not semver: the same result for the shapes a TIDAL folder name can have, without the dependency.
 */
export const compareVersions = (left: string, right: string): number => {
	const split = (version: string) => {
		const [release, ...pre] = version.split("-");
		return { segments: release.split(".").map(Number), pre: pre.join("-") };
	};
	const a = split(left);
	const b = split(right);
	for (let i = 0; i < Math.max(a.segments.length, b.segments.length); i++) {
		const difference = (a.segments[i] ?? 0) - (b.segments[i] ?? 0);
		if (difference !== 0) return difference;
	}
	// A prerelease sorts before its release; two prereleases of one release compare as equal, which is enough here
	if (a.pre === b.pre) return 0;
	if (a.pre === "") return 1;
	if (b.pre === "") return -1;
	return 0;
};

const toInstall = (appDir: string, version?: string): TidalInstall => ({
	appDir,
	resourcesDir: path.join(appDir, "resources"),
	version,
});

/** The `app-<version>` folders under a Squirrel root, newest first. Only folders that hold a `resources` dir */
export const listVersionDirs = async (baseDir: string): Promise<TidalInstall[]> => {
	const names = await readdir(baseDir).catch(() => <string[]>[]);
	const installs: TidalInstall[] = [];
	for (const name of names) {
		const version = versionOfAppDir(name);
		if (version === undefined) continue;
		const appDir = path.join(baseDir, name);
		if (!(await isDir(path.join(appDir, "resources")))) continue;
		installs.push(toInstall(appDir, version));
	}
	return installs.sort((left, right) => compareVersions(right.version!, left.version!));
};

/** A TIDAL installed at a fixed path, e.g. `/opt/tidal-hifi`, where no folder name carries the version */
export const installAt = async (appDir: string, version?: string): Promise<TidalInstall | undefined> =>
	(await isDir(path.join(appDir, "resources"))) ? toInstall(appDir, version) : undefined;

/** Every TIDAL install the given roots hold, newest first, with duplicates (a symlinked root) removed */
export const findTidalInstalls = async (roots: TidalRoot[]): Promise<TidalInstall[]> => {
	const found: TidalInstall[] = [];
	for (const root of roots) {
		if (root.versioned) found.push(...(await listVersionDirs(root.dir)));
		else {
			const install = await installAt(root.dir);
			if (install !== undefined) found.push(install);
		}
	}
	const seen = new Set<string>();
	return found
		.filter(({ resourcesDir }) => {
			if (seen.has(resourcesDir)) return false;
			seen.add(resourcesDir);
			return true;
		})
		.sort((left, right) => (left.version === undefined || right.version === undefined ? 0 : compareVersions(right.version, left.version)));
};

/**
 * Where TIDAL is installed, per platform. Mirrors what the Luna installer probes, so both find the same install:
 * Squirrel's per-user folder on Windows, the flatpak and package paths on Linux, the bundle on macOS.
 */
export const defaultTidalRoots = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): TidalRoot[] => {
	if (platform === "win32") {
		const localAppData = env.LOCALAPPDATA;
		return localAppData === undefined ? [] : [{ dir: path.join(localAppData, "TIDAL"), versioned: true }];
	}
	if (platform === "darwin") {
		return [
			{ dir: "/Applications/TIDAL.app/Contents", versioned: false },
			{ dir: path.join(home, "Applications/TIDAL.app/Contents"), versioned: false },
		];
	}
	const flatpak = path.join(home, ".local/share/flatpak/app/com.mastermindzh.tidal-hifi");
	return [
		{ dir: "/opt/tidal-hifi", versioned: false },
		{ dir: "/usr/lib/tidal-hifi", versioned: false },
		{ dir: "/usr/share/tidal-hifi", versioned: false },
		{ dir: "/var/lib/flatpak/app/com.mastermindzh.tidal-hifi/current/active/files/lib/tidal-hifi", versioned: false },
		{ dir: path.join(flatpak, "current/active/files/lib/tidal-hifi"), versioned: false },
	];
};

/**
 * A `resources` folder is the only thing an install mutates, so refuse anything that is not one: an absolute path whose
 * last segment is `resources`, with the app folder above it. Same shape check the updater makes before its own swap.
 *
 * Links are resolved first and the resolved path is what callers work with. A `resources` that is a junction pointing
 * somewhere else would otherwise send every write, rename and delete to that somewhere else, and checking the path string
 * alone cannot see it.
 */
const assertResourcesDir = async (resourcesDir: string) => {
	const resolved = path.resolve(resourcesDir);
	if (path.basename(resolved) !== "resources") throw new Error(`[TIDAL] Refusing to write to "${resolved}": not a resources folder`);
	const real = await realpath(resolved).catch(() => {
		throw new Error(`[TIDAL] Refusing to write to "${resolved}": it is not there`);
	});
	if (path.basename(real) !== "resources") {
		throw new Error(`[TIDAL] Refusing to write to "${resolved}": it resolves to "${real}", which is not a resources folder`);
	}
	const segments = real.split(path.sep).filter(Boolean);
	if (segments.length < 3) throw new Error(`[TIDAL] Refusing to write to "${real}": path too shallow`);
	return real;
};

/**
 * Refuses a name that exists as a link. Deleting, renaming or copying through one writes to wherever it points, so the
 * only safe answer is to leave it alone and let a person look.
 */
const assertNotLink = async (target: string, what: string) => {
	const info = await lstat(target).catch(() => undefined);
	if (info?.isSymbolicLink() === true) throw new Error(`[TIDAL] Refusing to touch ${what}: "${target}" is a link`);
};

/**
 * Refuses a build tree that holds a link.
 *
 * `cp` with `verbatimSymlinks` keeps links as links, so a link inside a dist would be installed as one and Luna would
 * then serve whatever it points at. A release archive cannot carry one (entries are extracted as regular files), so a
 * link here means the folder was assembled by something other than an unpacked release, and it is not installed.
 */
const assertNoLinks = async (root: string, dir = root): Promise<void> => {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const target = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`[TIDAL] Refusing to install "${root}": "${target}" is a link`);
		if (entry.isDirectory()) await assertNoLinks(root, target);
	}
};

/**
 * Checks a folder is a Luna build before it becomes one: the same promise the release gate makes about the archive, made
 * about what will actually be installed. A truncated extraction, a tampered copy or a path that is not a Luna dist stops
 * here rather than after TIDAL's asar has been moved aside.
 */
const assertDist = async (distDir: string) => {
	if (!(await isDir(distDir))) throw new Error(`[TIDAL] No dist to install at "${distDir}"`);
	await assertNoLinks(distDir);
	const raw = await readFile(path.join(distDir, "package.json"), "utf8").catch(() => undefined);
	if (raw === undefined) throw new Error(`[TIDAL] "${distDir}" has no package.json, so it is not a Luna build`);
	let name: unknown;
	try {
		name = JSON.parse(raw).name;
	} catch {
		throw new Error(`[TIDAL] "${distDir}" has a package.json that is not json`);
	}
	if (name !== "luna") throw new Error(`[TIDAL] "${distDir}" is the build of "${String(name)}", not Luna`);
	// The two files the injector boots: installing without them, or with an empty one, would leave TIDAL unbootable
	for (const required of ["injector.mjs", "luna.mjs"]) {
		const info = await stat(path.join(distDir, required)).catch(() => undefined);
		if (info?.isFile() !== true || info.size === 0) throw new Error(`[TIDAL] "${distDir}" has no usable ${required}`);
	}
};

const readMarker = async (appDir: string): Promise<LunaInstall | undefined> => {
	const raw = await readFile(path.join(appDir, INSTALL_MARKER), "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw);
		// A marker we cannot use is no marker: the folder is then treated as not ours
		return typeof parsed?.lunaVersion === "string" ? <LunaInstall>parsed : undefined;
	} catch {
		return undefined;
	}
};

/** What is in a `resources` folder now, without changing anything */
export const injectionState = async (resourcesDir: string): Promise<InjectionState> => {
	const appDir = path.join(resourcesDir, "app");
	const hasAsar = await isFile(path.join(resourcesDir, "app.asar"));
	if (await isDir(appDir)) {
		const install = await readMarker(appDir);
		if (install !== undefined) return { kind: "injected", install };
		return { kind: "foreign", reason: "resources/app exists but holds no Luna install marker" };
	}
	if (hasAsar || (await isFile(path.join(resourcesDir, "original.asar")))) return { kind: "vanilla", hasAsar };
	return { kind: "empty" };
};

/**
 * Puts `distDir` into `resourcesDir` as an installed Luna, the way the installer does it: TIDAL's asar is kept as
 * `original.asar` (never replacing one that is already there), Luna is staged beside and swapped in, and `app.asar` is
 * removed so it cannot shadow `resources/app`.
 *
 * The order matters: TIDAL's asar is preserved before anything is removed, and the swap happens before `app.asar` goes,
 * so a failure at any step leaves a bootable TIDAL.
 */
export const injectLuna = async (
	resourcesDir: string,
	distDir: string,
	{ lunaVersion, tidalVersion }: { lunaVersion: string; tidalVersion?: string },
): Promise<LunaInstall> => {
	const resolved = await assertResourcesDir(resourcesDir);
	await assertDist(distDir);

	const appDir = path.join(resolved, "app");
	const appAsar = path.join(resolved, "app.asar");
	const originalAsar = path.join(resolved, "original.asar");
	const staged = path.join(resolved, "app.new");
	const previous = path.join(resolved, "app.old");
	for (const target of [appDir, appAsar, originalAsar, staged, previous]) {
		if (!isInside(resolved, target)) throw new Error(`[TIDAL] Refusing to write outside "${resolved}": "${target}"`);
	}
	// Every one of these is renamed, copied or deleted below, so a link among them is refused before anything happens
	await assertNotLink(appDir, "resources/app");
	await assertNotLink(appAsar, "app.asar");
	await assertNotLink(originalAsar, "original.asar");
	await assertNotLink(staged, "app.new");
	await assertNotLink(previous, "app.old");

	if (!(await isFile(originalAsar))) {
		if (!(await isFile(appAsar))) throw new Error(`[TIDAL] "${resolved}" holds neither app.asar nor original.asar: not a TIDAL install`);
		await copyFile(appAsar, originalAsar);
	}
	const asar = await stat(originalAsar);

	// Staged beside the install, so a copy that fails part way leaves the current Luna untouched
	const install: LunaInstall = {
		lunaVersion,
		tidalVersion,
		asarBytes: asar.size,
		asarMtimeMs: asar.mtimeMs,
		injectedAt: new Date().toISOString(),
	};
	await rm(staged, { recursive: true, force: true });
	try {
		await cp(distDir, staged, { recursive: true, verbatimSymlinks: true });
		await writeFile(path.join(staged, INSTALL_MARKER), JSON.stringify(install, null, "\t"));
		// What was staged has to be the build that was checked, not a link that was followed into it
		await assertDist(staged);
	} catch (err) {
		await rm(staged, { recursive: true, force: true }).catch(() => {});
		throw err;
	}

	await rm(previous, { recursive: true, force: true });
	if (await isDir(appDir)) await rename(appDir, previous);
	try {
		await rename(staged, appDir);
	} catch (err) {
		// Put the previous install back rather than leaving a gap
		await rename(previous, appDir).catch(() => {});
		throw err;
	}
	// Only now is there an `app` to boot: nothing may shadow it
	await rm(appAsar, { force: true });
	await rm(previous, { recursive: true, force: true }).catch(() => {});

	// Read it back: an install that does not report a marker is not one, whatever the steps above returned
	const written = await injectionState(resolved);
	if (written.kind !== "injected" || written.install.lunaVersion !== lunaVersion) {
		throw new Error(`[TIDAL] The install into "${resolved}" did not verify after writing it (${written.kind})`);
	}
	return written.install;
};

/** Takes Luna back out: TIDAL's asar returns to `app.asar` and `resources/app` goes */
export const uninjectLuna = async (resourcesDir: string): Promise<void> => {
	const resolved = await assertResourcesDir(resourcesDir);
	const appDir = path.join(resolved, "app");
	const appAsar = path.join(resolved, "app.asar");
	const originalAsar = path.join(resolved, "original.asar");
	if (!isInside(resolved, appDir) || !isInside(resolved, appAsar)) throw new Error(`[TIDAL] Refusing to write outside "${resolved}"`);
	await assertNotLink(appDir, "resources/app");
	await assertNotLink(appAsar, "app.asar");
	await assertNotLink(originalAsar, "original.asar");

	if (!(await isFile(appAsar)) && (await isFile(originalAsar))) await copyFile(originalAsar, appAsar);
	await rm(appDir, { recursive: true, force: true });
};
