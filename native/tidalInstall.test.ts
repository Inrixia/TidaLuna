import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	compareVersions,
	defaultTidalRoots,
	findTidalInstalls,
	injectionState,
	injectLuna,
	INSTALL_MARKER,
	listVersionDirs,
	uninjectLuna,
	versionOfAppDir,
} from "./tidalInstall";

/**
 * Putting Luna into TIDAL's folders, and knowing what is already there.
 *
 * Every test works on a temp folder shaped like a TIDAL install, because the thing being tested is exactly which files
 * get written, kept and removed. The interesting cases are the ones a TIDAL update creates: a new version folder with
 * only `app.asar`, an older folder that still holds Luna, and a folder that is not ours at all.
 */
let dir: string;
/** A folder shaped like a TIDAL install: `app-<version>/resources` with TIDAL's asar in it */
const tidalInstall = async (name = "app-2.48.0", asar = "tidal-asar-bytes") => {
	const appDir = path.join(dir, name);
	const resourcesDir = path.join(appDir, "resources");
	await mkdir(resourcesDir, { recursive: true });
	if (asar !== "") await writeFile(path.join(resourcesDir, "app.asar"), asar);
	return { appDir, resourcesDir };
};
/** A folder shaped like a Luna dist (what `pnpm run build` writes) */
const lunaDist = async (files: Record<string, string> = {}) => {
	const dist = path.join(dir, "dist");
	await mkdir(dist, { recursive: true });
	const contents = {
		"package.json": JSON.stringify({ name: "luna", version: "1.26.0" }),
		"injector.mjs": "luna-injector",
		"luna.mjs": "luna-core",
		...files,
	};
	for (const [name, value] of Object.entries(contents)) await writeFile(path.join(dist, name), value);
	return dist;
};
/** A directory link, which needs no admin rights on Windows (a junction) */
const linkDir = async (target: string, at: string) => symlink(target, at, process.platform === "win32" ? "junction" : "dir");
const namesIn = async (target: string) => (await readdir(target)).sort();

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-tidal-install-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("versionOfAppDir", () => {
	test("reads the version out of a Squirrel folder name", () => {
		expect(versionOfAppDir("app-2.48.0")).toBe("2.48.0");
		expect(versionOfAppDir("app-2.48.0-beta")).toBe("2.48.0-beta");
		expect(versionOfAppDir("app-1.0")).toBe("1.0");
	});

	test("ignores a folder name it cannot read as a version", () => {
		for (const name of ["app-", "app-latest", "app-2.48.0!", "resources", "packages", "app-2.48.0 beta"]) {
			expect(versionOfAppDir(name)).toBeUndefined();
		}
	});
});

describe("compareVersions", () => {
	test("orders by number, not by text", () => {
		expect(compareVersions("2.10.0", "2.9.0")).toBeGreaterThan(0);
		expect(compareVersions("2.48.0", "2.47.9")).toBeGreaterThan(0);
		expect(compareVersions("2.47.9", "2.48.0")).toBeLessThan(0);
	});

	test("sorts a prerelease before its release", () => {
		expect(compareVersions("2.48.0", "2.48.0-beta")).toBeGreaterThan(0);
		expect(compareVersions("2.48.0-beta", "2.48.0")).toBeLessThan(0);
	});

	test("treats missing and equal segments as equal", () => {
		expect(compareVersions("2.48", "2.48.0")).toBe(0);
		expect(compareVersions("2.48.0", "2.48.0")).toBe(0);
		expect(compareVersions("2.48.0-beta", "2.48.0-beta")).toBe(0);
	});
});

describe("finding TIDAL's installs", () => {
	test("lists the version folders newest first and skips anything else", async () => {
		await tidalInstall("app-2.47.9");
		await tidalInstall("app-2.48.0");
		await tidalInstall("app-2.49.0-beta");
		// Not a version folder, a version folder without resources, and a loose file
		await mkdir(path.join(dir, "packages"), { recursive: true });
		await mkdir(path.join(dir, "app-9.9.9"), { recursive: true });
		await writeFile(path.join(dir, "Update.exe"), "");

		const installs = await listVersionDirs(dir);

		expect(installs.map(({ version }) => version)).toEqual(["2.49.0-beta", "2.48.0", "2.47.9"]);
		expect(installs[0].resourcesDir).toBe(path.join(dir, "app-2.49.0-beta", "resources"));
	});

	test("returns nothing for a folder that is not there", async () => {
		expect(await listVersionDirs(path.join(dir, "nope"))).toEqual([]);
	});

	test("finds a TIDAL installed at a fixed path, with no version in it", async () => {
		const { appDir } = await tidalInstall("tidal-hifi");

		const installs = await findTidalInstalls([{ dir: appDir, versioned: false }]);

		expect(installs).toHaveLength(1);
		expect(installs[0].version).toBeUndefined();
		expect(installs[0].resourcesDir).toBe(path.join(appDir, "resources"));
	});

	test("puts the newest first across several roots and drops duplicates", async () => {
		const older = await tidalInstall("app-2.47.0");
		const newest = await tidalInstall("app-2.48.0");

		const installs = await findTidalInstalls([
			{ dir: dir, versioned: true },
			// The same folder reached twice
			{ dir: newest.appDir, versioned: false },
		]);

		expect(installs.map(({ resourcesDir }) => resourcesDir)).toEqual([newest.resourcesDir, older.resourcesDir]);
	});

	test("knows where TIDAL lives per platform", () => {
		expect(defaultTidalRoots({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a")).toEqual([
			{ dir: path.join("C:\\Users\\a\\AppData\\Local", "TIDAL"), versioned: true },
		]);
		// No LOCALAPPDATA: no guess, rather than probing a made up path
		expect(defaultTidalRoots({}, "win32", "C:\\Users\\a")).toEqual([]);
		expect(defaultTidalRoots({}, "linux", "/home/a").map(({ dir }) => dir)).toContain("/opt/tidal-hifi");
		expect(defaultTidalRoots({}, "darwin", "/Users/a").map(({ dir }) => dir)).toContain("/Applications/TIDAL.app/Contents");
	});
});

describe("injectionState", () => {
	test("a version folder a TIDAL update just added is vanilla", async () => {
		const { resourcesDir } = await tidalInstall();

		expect(await injectionState(resourcesDir)).toEqual({ kind: "vanilla", hasAsar: true });
	});

	test("a folder with only original.asar is vanilla and has no asar to work from", async () => {
		const { resourcesDir } = await tidalInstall("app-2.48.0", "");
		await writeFile(path.join(resourcesDir, "original.asar"), "tidal");

		expect(await injectionState(resourcesDir)).toEqual({ kind: "vanilla", hasAsar: false });
	});

	test("a folder with nothing in it is empty, not vanilla", async () => {
		await mkdir(path.join(dir, "app-2.48.0", "resources"), { recursive: true });

		expect(await injectionState(path.join(dir, "app-2.48.0", "resources"))).toEqual({ kind: "empty" });
	});

	test("recognises a Luna it installed", async () => {
		const { resourcesDir } = await tidalInstall();
		await injectLuna(resourcesDir, await lunaDist(), { lunaVersion: "1.26.0", tidalVersion: "2.48.0" });

		const state = await injectionState(resourcesDir);
		expect(state.kind).toBe("injected");
		if (state.kind !== "injected") return;
		expect(state.install.lunaVersion).toBe("1.26.0");
		expect(state.install.tidalVersion).toBe("2.48.0");
		expect(state.install.asarBytes).toBe("tidal-asar-bytes".length);
	});

	test("a resources/app that is not ours is foreign, not an install to trust", async () => {
		const { resourcesDir } = await tidalInstall();
		await mkdir(path.join(resourcesDir, "app"), { recursive: true });
		await writeFile(path.join(resourcesDir, "app", "injector.mjs"), "someone else");

		const state = await injectionState(resourcesDir);
		expect(state.kind).toBe("foreign");
	});

	test("an unreadable marker is treated as no marker", async () => {
		const { resourcesDir } = await tidalInstall();
		await mkdir(path.join(resourcesDir, "app"), { recursive: true });
		await writeFile(path.join(resourcesDir, "app", INSTALL_MARKER), "{ not json");

		expect((await injectionState(resourcesDir)).kind).toBe("foreign");
	});
});

describe("injectLuna", () => {
	test("keeps TIDAL's asar as original.asar, installs Luna and removes app.asar", async () => {
		const { resourcesDir } = await tidalInstall("app-2.48.0", "tidal-asar-bytes");
		const dist = await lunaDist();

		const install = await injectLuna(resourcesDir, dist, { lunaVersion: "1.26.0", tidalVersion: "2.48.0" });

		expect(await readFile(path.join(resourcesDir, "original.asar"), "utf8")).toBe("tidal-asar-bytes");
		expect(await namesIn(resourcesDir)).toEqual(["app", "original.asar"]);
		expect(await namesIn(path.join(resourcesDir, "app"))).toEqual([INSTALL_MARKER, "injector.mjs", "luna.mjs", "package.json"]);
		expect(JSON.parse(await readFile(path.join(resourcesDir, "app", INSTALL_MARKER), "utf8"))).toEqual(install);
	});

	test("never replaces an original.asar that is already there", async () => {
		const { resourcesDir } = await tidalInstall("app-2.48.0", "the asar TIDAL just shipped");
		await writeFile(path.join(resourcesDir, "original.asar"), "the asar TIDAL shipped before");

		await injectLuna(resourcesDir, await lunaDist(), { lunaVersion: "1.26.0" });

		// The older copy is the one the injector boots, so it must survive a second install
		expect(await readFile(path.join(resourcesDir, "original.asar"), "utf8")).toBe("the asar TIDAL shipped before");
	});

	test("replaces a resources/app it did not write, leaving no leftovers", async () => {
		const { resourcesDir } = await tidalInstall();
		await mkdir(path.join(resourcesDir, "app"), { recursive: true });
		await writeFile(path.join(resourcesDir, "app", "stale.mjs"), "old");
		await mkdir(path.join(resourcesDir, "app.old"), { recursive: true });

		await injectLuna(resourcesDir, await lunaDist(), { lunaVersion: "1.26.0" });

		expect(await namesIn(resourcesDir)).toEqual(["app", "original.asar"]);
		expect(await namesIn(path.join(resourcesDir, "app"))).toEqual([INSTALL_MARKER, "injector.mjs", "luna.mjs", "package.json"]);
	});

	test("is idempotent: installing twice leaves one install and a fresh marker", async () => {
		const { resourcesDir } = await tidalInstall();
		const dist = await lunaDist();

		const first = await injectLuna(resourcesDir, dist, { lunaVersion: "1.26.0", tidalVersion: "2.48.0" });
		const second = await injectLuna(resourcesDir, dist, { lunaVersion: "1.27.0", tidalVersion: "2.48.0" });

		expect(await namesIn(resourcesDir)).toEqual(["app", "original.asar"]);
		expect(second.lunaVersion).toBe("1.27.0");
		expect(second.injectedAt >= first.injectedAt).toBe(true);
		expect((await injectionState(resourcesDir)).kind).toBe("injected");
	});

	test("refuses to write into something that is not a TIDAL resources folder", async () => {
		const dist = await lunaDist();
		const notResources = path.join(dir, "app-2.48.0");
		await mkdir(notResources, { recursive: true });

		await expect(injectLuna(notResources, dist, { lunaVersion: "1.26.0" })).rejects.toThrow(/not a resources folder/);
		await expect(injectLuna(path.join(dir, "a", "b", "c"), dist, { lunaVersion: "1.26.0" })).rejects.toThrow(/resources folder/);
	});

	test("changes nothing when the folder holds no TIDAL asar at all", async () => {
		const { resourcesDir } = await tidalInstall("app-2.48.0", "");
		await mkdir(path.join(resourcesDir, "app"), { recursive: true });

		await expect(injectLuna(resourcesDir, await lunaDist(), { lunaVersion: "1.26.0" })).rejects.toThrow(/not a TIDAL install/);

		// Nothing was removed or staged before the refusal
		expect(await namesIn(resourcesDir)).toEqual(["app"]);
	});

	test("changes nothing when the dist is not there", async () => {
		const { resourcesDir } = await tidalInstall();

		await expect(injectLuna(resourcesDir, path.join(dir, "no-dist"), { lunaVersion: "1.26.0" })).rejects.toThrow(/No dist/);

		// TIDAL is still bootable: its asar was not removed and nothing was staged
		expect(await namesIn(resourcesDir)).toEqual(["app.asar"]);
	});
});

describe("uninjectLuna", () => {
	test("puts TIDAL's asar back and removes Luna", async () => {
		const { resourcesDir } = await tidalInstall("app-2.48.0", "tidal-asar-bytes");
		await injectLuna(resourcesDir, await lunaDist(), { lunaVersion: "1.26.0" });

		await uninjectLuna(resourcesDir);

		expect(await namesIn(resourcesDir)).toEqual(["app.asar", "original.asar"]);
		expect(await readFile(path.join(resourcesDir, "app.asar"), "utf8")).toBe("tidal-asar-bytes");
	});

	test("leaves an asar that is already back alone", async () => {
		const { resourcesDir } = await tidalInstall("app-2.48.0", "tidal-asar-bytes");
		await writeFile(path.join(resourcesDir, "original.asar"), "older copy");

		await uninjectLuna(resourcesDir);

		expect(await readFile(path.join(resourcesDir, "app.asar"), "utf8")).toBe("tidal-asar-bytes");
	});
});

/**
 * What an install refuses.
 *
 * These are the cases where writing anyway would mean writing somewhere else, or booting something that is not Luna: a
 * folder that is a link, a build that is not a Luna build, and a path that is not a TIDAL install at all.
 */
describe("injectLuna refuses what it cannot trust", () => {
	test("a resources folder that is a link to somewhere else", async () => {
		const elsewhere = path.join(dir, "elsewhere");
		await mkdir(elsewhere, { recursive: true });
		await writeFile(path.join(elsewhere, "app.asar"), "someone else's app folder");
		const appDir = path.join(dir, "app-2.48.0");
		await mkdir(appDir, { recursive: true });
		const linked = path.join(appDir, "resources");
		await linkDir(elsewhere, linked);

		await expect(injectLuna(linked, await lunaDist(), { lunaVersion: "1.26.0" })).rejects.toThrow(/not a resources folder|resolves to/);

		// Nothing was written where the link points
		expect(await namesIn(elsewhere)).toEqual(["app.asar"]);
	});

	test("a resources/app that is a link", async () => {
		const { resourcesDir } = await tidalInstall();
		const outside = path.join(dir, "outside");
		await mkdir(outside, { recursive: true });
		await writeFile(path.join(outside, "keep.txt"), "keep");
		await linkDir(outside, path.join(resourcesDir, "app"));

		await expect(injectLuna(resourcesDir, await lunaDist(), { lunaVersion: "1.26.0" })).rejects.toThrow(/is a link/);

		// The folder it points at is untouched, and TIDAL's asar was not moved aside
		expect(await namesIn(outside)).toEqual(["keep.txt"]);
		expect(await namesIn(resourcesDir)).toEqual(["app", "app.asar"]);
	});

	test("a resources path that is not there", async () => {
		await expect(injectLuna(path.join(dir, "nope", "resources"), await lunaDist(), { lunaVersion: "1.26.0" })).rejects.toThrow(/it is not there/);
	});

	test("a dist that is not a Luna build", async () => {
		const { resourcesDir } = await tidalInstall();
		const notLuna = path.join(dir, "not-luna");
		await mkdir(notLuna, { recursive: true });
		await writeFile(path.join(notLuna, "package.json"), JSON.stringify({ name: "something-else", version: "1.0.0" }));

		await expect(injectLuna(resourcesDir, notLuna, { lunaVersion: "1.26.0" })).rejects.toThrow(/not Luna/);

		expect(await namesIn(resourcesDir)).toEqual(["app.asar"]);
	});

	test("a dist with no package.json at all", async () => {
		const { resourcesDir } = await tidalInstall();
		const bare = path.join(dir, "bare");
		await mkdir(bare, { recursive: true });

		await expect(injectLuna(resourcesDir, bare, { lunaVersion: "1.26.0" })).rejects.toThrow(/no package\.json/);
	});

	test("a dist without the files the injector boots", async () => {
		const { resourcesDir } = await tidalInstall();
		const dist = await lunaDist();
		await rm(path.join(dist, "luna.mjs"));

		await expect(injectLuna(resourcesDir, dist, { lunaVersion: "1.26.0" })).rejects.toThrow(/no usable luna\.mjs/);

		// Refused before TIDAL's asar was moved aside, so TIDAL still boots
		expect(await namesIn(resourcesDir)).toEqual(["app.asar"]);
	});

	test("a dist whose boot files are there but empty", async () => {
		const { resourcesDir } = await tidalInstall();

		await expect(injectLuna(resourcesDir, await lunaDist({ "injector.mjs": "" }), { lunaVersion: "1.26.0" })).rejects.toThrow(
			/no usable injector\.mjs/,
		);
	});
});

describe("injectLuna refuses a build tree that holds a link", () => {
	test("a link inside the dist would be served as part of Luna, so it is not installed", async () => {
		const { resourcesDir } = await tidalInstall();
		const dist = await lunaDist();
		const outside = path.join(dir, "outside");
		await mkdir(outside, { recursive: true });
		await writeFile(path.join(outside, "secret.mjs"), "not luna");
		await linkDir(outside, path.join(dist, "smuggled"));

		await expect(injectLuna(resourcesDir, dist, { lunaVersion: "1.26.0" })).rejects.toThrow(/is a link/);

		// Refused before anything was written into TIDAL's install
		expect(await namesIn(resourcesDir)).toEqual(["app.asar"]);
	});
});
