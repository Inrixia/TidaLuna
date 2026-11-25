import { createHash } from "crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { downloadZip, readReleases, runAutoUpdate, stateRootFor, tidalRunning } from "./autoUpdate";
import { COMPAT_ASSET } from "./compat";
import { newLunaState, writeLunaState } from "./lunaState";
import { LUNA_ASSET, releaseAssetUrl } from "./releaseGate";
import { injectionState } from "./tidalInstall";

/**
 * The unattended run's wiring: where Luna keeps its files, how GitHub is read, and what a run leaves behind.
 *
 * The run itself is tested in updateGuard.test.ts; this is about the outside world being read safely and the run being
 * answerable afterwards, since nobody is watching when it happens.
 */
const VERSION = "1.27.0";
const TIDAL = "2.48.0";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-auto-update-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("stateRootFor", () => {
	test("uses a folder of Luna's own on each platform", () => {
		const win = stateRootFor({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, home: "C:\\Users\\a" });
		expect(win).toBe(path.join("C:\\Users\\a\\AppData\\Local", "luna"));

		expect(stateRootFor({ platform: "darwin", env: {}, home: "/Users/a" })).toBe(path.join("/Users/a", "Library", "Application Support", "luna"));
		expect(stateRootFor({ platform: "linux", env: {}, home: "/home/a" })).toBe(path.join("/home/a", ".local", "share", "tidaluna"));
		// An XDG data dir is honoured when it is set
		expect(stateRootFor({ platform: "linux", env: { XDG_DATA_HOME: "/data" }, home: "/home/a" })).toBe(path.join("/data", "tidaluna"));
	});

	test("never puts Luna's state under TIDAL's own folder", () => {
		const win = stateRootFor({
			platform: "win32",
			env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", APPDATA: "C:\\Users\\a\\AppData\\Roaming" },
			home: "C:\\Users\\a",
		});

		// TIDAL's uninstall may clear its profile, and this folder is the record that Luna was installed at all
		expect(win).not.toContain("TIDAL");
		expect(win).not.toContain("Roaming");
	});

	test("a caller may say where, which is what a portable install or a test needs", () => {
		expect(stateRootFor({ platform: "linux", env: {}, home: "/home/a" }, "/custom")).toBe("/custom");
	});
});

describe("readReleases", () => {
	test("asks GitHub for the releases of this repo, with a user agent", async () => {
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify([{ tag_name: "1.2.3" }]), { status: 200 }));

		expect(await readReleases(fetchSpy as never)).toEqual([{ tag_name: "1.2.3" }]);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.github.com/repos/Inrixia/TidaLuna/releases",
			expect.objectContaining({ headers: expect.objectContaining({ "user-agent": "TidaLuna" }) }),
		);
	});

	test("names a rate limit as one, because an unauthenticated GitHub allows 60 an hour", async () => {
		await expect(readReleases((async () => new Response("", { status: 403 })) as never)).rejects.toThrow(/rate limit/);
		await expect(readReleases((async () => new Response("", { status: 429 })) as never)).rejects.toThrow(/rate limit/);
	});

	test("refuses a body that is not a list", async () => {
		await expect(readReleases((async () => new Response(JSON.stringify({ message: "nope" }), { status: 200 })) as never)).rejects.toThrow(
			/not a list/,
		);
	});

	test("reports a failure rather than returning an empty list, so nothing reads as no releases", async () => {
		await expect(readReleases((async () => new Response("", { status: 500, statusText: "Server Error" })) as never)).rejects.toThrow(
			/500 Server Error/,
		);
	});
});

describe("downloadZip", () => {
	test("reads the bytes it is served", async () => {
		const bytes = new TextEncoder().encode("archive");

		expect(await downloadZip((async () => new Response(bytes, { status: 200 })) as never, "https://x/y.zip")).toEqual(bytes);
	});

	test("refuses a download larger than a Luna build could be", async () => {
		const tooBig = { "content-length": String(1024 ** 3) };

		await expect(downloadZip((async () => new Response("small", { status: 200, headers: tooBig })) as never, "https://x/y.zip")).rejects.toThrow(
			/over the/,
		);
	});

	test("refuses a failed download", async () => {
		await expect(
			downloadZip((async () => new Response("", { status: 404, statusText: "Not Found" })) as never, "https://x/y.zip"),
		).rejects.toThrow(/404/);
	});
});

describe("tidalRunning", () => {
	test("reads the Windows process list", async () => {
		const found = "TIDAL.exe  1234 Console  1  120,000 K";

		expect(await tidalRunning(async () => found, "win32")).toBe(true);
		expect(await tidalRunning(async () => "INFO: No tasks are running", "win32")).toBe(false);
	});

	test("reads the Linux process list, and takes no answer as not running", async () => {
		expect(await tidalRunning(async () => "1234\n", "linux")).toBe(true);
		expect(await tidalRunning(async () => "", "linux")).toBe(false);
		// pgrep exits non-zero when nothing matches
		expect(
			await tidalRunning(async () => {
				throw new Error("exit 1");
			}, "linux"),
		).toBe(false);
	});
});

describe("runAutoUpdate", () => {
	const makeZip = async () => {
		const zip = new JSZip();
		zip.file("package.json", JSON.stringify({ name: "luna", version: VERSION }));
		zip.file("injector.mjs", "boot");
		zip.file("luna.mjs", "core");
		return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
	};

	/** A GitHub that serves one release, its compat file and its archive */
	const github = (zipBytes: Buffer) => {
		const sha = createHash("sha256").update(zipBytes).digest("hex");
		const release = {
			tag_name: VERSION,
			draft: false,
			prerelease: false,
			assets: [
				{ name: LUNA_ASSET, browser_download_url: releaseAssetUrl(VERSION), size: zipBytes.length, digest: `sha256:${sha}` },
				{ name: COMPAT_ASSET, browser_download_url: releaseAssetUrl(VERSION, COMPAT_ASSET), size: 100 },
			],
		};
		const compat = { luna: VERSION, tidal: { tested: [TIDAL] }, zip: { sha256: sha, bytes: zipBytes.length } };
		return vi.fn(async (url: string) => {
			if (url.includes("api.github.com")) return new Response(JSON.stringify([release]), { status: 200 });
			if (url.endsWith(COMPAT_ASSET)) return new Response(JSON.stringify(compat), { status: 200 });
			if (url.endsWith(LUNA_ASSET)) return new Response(new Uint8Array(zipBytes), { status: 200 });
			return new Response("", { status: 404 });
		});
	};

	/** A TIDAL install folder and a state that says Luna was installed here before */
	const setup = async () => {
		const tidalRoot = path.join(dir, "TIDAL");
		const resourcesDir = path.join(tidalRoot, `app-${TIDAL}`, "resources");
		await mkdir(resourcesDir, { recursive: true });
		await writeFile(path.join(resourcesDir, "app.asar"), "tidal-asar");
		await writeLunaState(path.join(dir, "luna"), newLunaState("1.26.0"));
		return { tidalRoot, resourcesDir };
	};

	test("installs, and writes what it did to a log nobody is watching", async () => {
		const { tidalRoot, resourcesDir } = await setup();
		const zipBytes = await makeZip();

		const outcome = await runAutoUpdate({
			platform: { platform: "win32", env: {}, home: dir },
			httpFetch: github(zipBytes) as never,
			run: async () => "",
			stateRoot: path.join(dir, "luna"),
			roots: [{ dir: tidalRoot, versioned: true }],
			now: new Date("2026-01-01T00:00:00.000Z"),
		});

		expect(outcome).toMatchObject({ action: "installed", installed: { version: VERSION } });
		expect((await injectionState(resourcesDir)).kind).toBe("injected");
		expect(await readFile(path.join(dir, "luna", "log", "update-guard.log"), "utf8")).toBe(
			`2026-01-01T00:00:00.000Z installed: Luna ${VERSION} installed for TIDAL ${TIDAL}\n`,
		);
	});

	test("logs a run that failed, since the failure is the thing worth reading later", async () => {
		const { tidalRoot } = await setup();

		await runAutoUpdate({
			platform: { platform: "win32", env: {}, home: dir },
			httpFetch: (async () => new Response("", { status: 500, statusText: "Server Error" })) as never,
			run: async () => "",
			stateRoot: path.join(dir, "luna"),
			roots: [{ dir: tidalRoot, versioned: true }],
			now: new Date("2026-01-01T00:00:00.000Z"),
		});

		const log = await readFile(path.join(dir, "luna", "log", "update-guard.log"), "utf8");
		expect(log).toContain("2026-01-01T00:00:00.000Z failed:");
		expect(log).toContain("500 Server Error");
	});

	test("refuses while TIDAL runs, without reading GitHub at all", async () => {
		const { tidalRoot, resourcesDir } = await setup();
		const fetchSpy = github(await makeZip());

		const outcome = await runAutoUpdate({
			platform: { platform: "win32", env: {}, home: dir },
			httpFetch: fetchSpy as never,
			run: async () => "TIDAL.exe  1234 Console",
			stateRoot: path.join(dir, "luna"),
			roots: [{ dir: tidalRoot, versioned: true }],
			now: new Date("2026-01-01T00:00:00.000Z"),
		});

		expect(outcome).toMatchObject({ action: "refused", reason: expect.stringMatching(/TIDAL is running/) });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect((await injectionState(resourcesDir)).kind).toBe("vanilla");
		// The quiet runs are logged too: "why did nothing happen" is a question about them
		expect(await readFile(path.join(dir, "luna", "log", "update-guard.log"), "utf8")).toContain("refused: TIDAL is running");
	});
});
