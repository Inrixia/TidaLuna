import { createHash } from "crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { COMPAT_ASSET } from "./compat";
import { newLunaState, readLunaState, recordInstall, writeLunaState } from "./lunaState";
import { LUNA_ASSET, releaseAssetUrl, type ReleaseInfo } from "./releaseGate";
import { injectLuna, INSTALL_MARKER, injectionState } from "./tidalInstall";
import { runUpdateGuard, type GuardDeps } from "./updateGuard";

/**
 * The whole run, with its outside world faked.
 *
 * Two properties are worth more than the rest and are asserted throughout: a run that has nothing to do does not touch the
 * network at all, and a run that fails at any step leaves TIDAL's install exactly as it was.
 */
const VERSION = "1.27.0";
const TIDAL = "2.48.0";

let dir: string;
let stateRoot: string;
let tidalRoot: string;
let resourcesDir: string;

const makeZip = async () => {
	const zip = new JSZip();
	zip.file("package.json", JSON.stringify({ name: "luna", version: VERSION }));
	zip.file("injector.mjs", "boot");
	zip.file("luna.mjs", "core");
	return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
};

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A release that passes the gate, plus the compat file that describes it */
const releaseFixture = (zipBytes: Uint8Array, compat: unknown = undefined) => {
	const release: ReleaseInfo = {
		tag_name: VERSION,
		draft: false,
		prerelease: false,
		assets: [
			{ name: LUNA_ASSET, browser_download_url: releaseAssetUrl(VERSION), size: zipBytes.length, digest: `sha256:${sha(zipBytes)}` },
			{ name: COMPAT_ASSET, browser_download_url: releaseAssetUrl(VERSION, COMPAT_ASSET), size: 100 },
		],
	};
	const compatFile = compat ?? { luna: VERSION, tidal: { tested: [TIDAL] }, zip: { sha256: sha(zipBytes), bytes: zipBytes.length } };
	return { release, compatFile };
};

/** A TIDAL install folder shaped like Squirrel's, with or without Luna already in it */
const tidalInstall = async (options: { injected?: boolean; asar?: string } = {}) => {
	tidalRoot = path.join(dir, "TIDAL");
	resourcesDir = path.join(tidalRoot, `app-${TIDAL}`, "resources");
	await mkdir(resourcesDir, { recursive: true });
	await writeFile(path.join(resourcesDir, "app.asar"), options.asar ?? "tidal-asar");
	if (options.injected === true) {
		const dist = path.join(dir, "old-dist");
		await mkdir(dist, { recursive: true });
		await writeFile(path.join(dist, "package.json"), JSON.stringify({ name: "luna", version: "1.26.0" }));
		await writeFile(path.join(dist, "injector.mjs"), "boot");
		await writeFile(path.join(dist, "luna.mjs"), "core");
		await injectLuna(resourcesDir, dist, { lunaVersion: "1.26.0", tidalVersion: TIDAL });
	}
};

/** Writes the state Luna would have left behind from a previous install */
const withState = async (overrides: { pinnedVersion?: string } = {}) => {
	const state = { ...newLunaState("1.26.0"), ...overrides };
	await writeLunaState(stateRoot, state);
	return state;
};

const deps = (zipBytes: Buffer, compat: unknown = undefined, overrides: Partial<GuardDeps> = {}): GuardDeps => {
	const { release, compatFile } = releaseFixture(zipBytes, compat);
	return {
		roots: [{ dir: tidalRoot, versioned: true }],
		stateRoot,
		fetchReleases: vi.fn(async () => [release]),
		fetchCompat: vi.fn(async () => compatFile),
		fetchZip: vi.fn(async () => zipBytes),
		...overrides,
	};
};

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-update-guard-"));
	stateRoot = path.join(dir, "luna");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("runUpdateGuard does nothing, cheaply", () => {
	test("with no TIDAL installed", async () => {
		await mkdir(stateRoot, { recursive: true });
		const d = deps(await makeZip(), undefined, { roots: [{ dir: path.join(dir, "nope"), versioned: true }] });

		expect(await runUpdateGuard(d)).toMatchObject({ action: "none", reason: expect.stringMatching(/no TIDAL install/) });
		expect(d.fetchReleases).not.toHaveBeenCalled();
	});

	test("when Luna was never installed here, without touching the network", async () => {
		await tidalInstall();
		const d = deps(await makeZip());

		expect(await runUpdateGuard(d)).toMatchObject({ action: "none" });
		// The rule that keeps this from installing a client mod uninvited also keeps it offline
		expect(d.fetchReleases).not.toHaveBeenCalled();
		expect(d.fetchZip).not.toHaveBeenCalled();
	});

	test("when the install is already current, without touching the network", async () => {
		await tidalInstall({ injected: true });
		const { install } = {
			install: (await injectionState(resourcesDir)) as { kind: "injected"; install: { asarBytes: number; asarMtimeMs: number } },
		};
		await withState();
		const state = (await readLunaState(stateRoot))!;

		await writeLunaState(
			stateRoot,
			recordInstall(state, resourcesDir, {
				tidalVersion: TIDAL,
				injectedAt: "2026-01-01T00:00:00.000Z",
				lunaVersion: "1.26.0",
				...install.install,
			}),
		);
		const d = deps(await makeZip());

		expect(await runUpdateGuard(d)).toMatchObject({ action: "none", reason: expect.stringMatching(/already has Luna/) });
		expect(d.fetchReleases).not.toHaveBeenCalled();
	});
});

describe("runUpdateGuard installs when TIDAL was updated", () => {
	test("puts the picked release into the new version folder and records it", async () => {
		await tidalInstall();
		await withState();
		const zipBytes = await makeZip();

		const result = await runUpdateGuard(deps(zipBytes));

		expect(result).toMatchObject({ action: "installed", installed: { version: VERSION } });
		// Luna is in the install, next to TIDAL's asar, with its marker inside resources/app
		const state = await injectionState(resourcesDir);
		expect(state.kind).toBe("injected");
		expect(state.kind === "injected" && state.install.lunaVersion).toBe(VERSION);
		expect(JSON.parse(await readFile(path.join(resourcesDir, "app", INSTALL_MARKER), "utf8"))).toMatchObject({ lunaVersion: VERSION });
		// TIDAL's asar was kept, and app.asar is gone so nothing shadows Luna
		expect(await readFile(path.join(resourcesDir, "original.asar"), "utf8")).toBe("tidal-asar");
		await expect(stat(path.join(resourcesDir, "app.asar"))).rejects.toThrow();
		// The state says which build is in which install now
		const written = await readLunaState(stateRoot);
		expect(written?.lunaVersion).toBe(VERSION);
		expect(Object.keys(written?.installs ?? {})).toEqual([resourcesDir]);
	});

	test("keeps the verified build outside TIDAL's tree, for a repair with no network", async () => {
		await tidalInstall();
		await withState();

		await runUpdateGuard(deps(await makeZip()));

		expect(await readFile(path.join(stateRoot, "build", "injector.mjs"), "utf8")).toBe("boot");
		// And nothing is left half unpacked
		await expect(stat(path.join(stateRoot, "build.new"))).rejects.toThrow();
	});

	test("refuses while TIDAL is running, and writes nothing", async () => {
		await tidalInstall();
		await withState();
		const d = deps(await makeZip(), undefined, { isTidalRunning: async () => true });

		expect(await runUpdateGuard(d)).toMatchObject({ action: "refused", reason: expect.stringMatching(/TIDAL is running/) });
		// Refused before anything was downloaded, let alone installed
		expect(d.fetchReleases).not.toHaveBeenCalled();
		expect((await injectionState(resourcesDir)).kind).toBe("vanilla");
	});

	test("honours a pin", async () => {
		await tidalInstall();
		await withState({ pinnedVersion: VERSION });

		expect(await runUpdateGuard(deps(await makeZip()))).toMatchObject({ action: "installed", installed: { version: VERSION } });
	});
});

describe("runUpdateGuard refuses rather than half installing", () => {
	test("when nothing compatible is published", async () => {
		await tidalInstall();
		await withState();
		const zipBytes = await makeZip();
		// A release that says this TIDAL is outside its support
		const d = deps(zipBytes, { luna: VERSION, tidal: { tested: ["2.44.0"] }, zip: { sha256: sha(zipBytes), bytes: zipBytes.length } });

		const result = await runUpdateGuard(d);

		expect(result).toMatchObject({ action: "refused" });
		expect(d.fetchZip).not.toHaveBeenCalled();
		expect((await injectionState(resourcesDir)).kind).toBe("vanilla");
	});

	test("when a release's two digests disagree, before anything is downloaded", async () => {
		await tidalInstall();
		await withState();
		const zipBytes = await makeZip();
		// compat names one archive, GitHub's own asset digest names another: neither is believed
		const d = deps(zipBytes, { luna: VERSION, tidal: { tested: [TIDAL] }, zip: { sha256: "0".repeat(64), bytes: zipBytes.length } });

		const result = await runUpdateGuard(d);

		expect(result).toMatchObject({ action: "refused" });
		expect(d.fetchZip).not.toHaveBeenCalled();
		expect((await injectionState(resourcesDir)).kind).toBe("vanilla");
	});

	test("when the published digest does not match the bytes served, leaving TIDAL untouched", async () => {
		await tidalInstall();
		await withState();
		const zipBytes = await makeZip();
		const wrong = "0".repeat(64);
		const { release } = releaseFixture(zipBytes);
		// Both digests agree with each other and disagree with the bytes, so only the download check can catch it
		const d = deps(
			zipBytes,
			{ luna: VERSION, tidal: { tested: [TIDAL] }, zip: { sha256: wrong, bytes: zipBytes.length } },
			{
				fetchReleases: async () => [{ ...release, assets: [{ ...release.assets![0], digest: `sha256:${wrong}` }, release.assets![1]] }],
			},
		);

		const result = await runUpdateGuard(d);

		expect(result).toMatchObject({ action: "failed", reason: expect.stringMatching(/refused/) });
		// TIDAL still boots: its asar was never moved, and nothing was unpacked anywhere
		expect((await injectionState(resourcesDir)).kind).toBe("vanilla");
		expect(await readFile(path.join(resourcesDir, "app.asar"), "utf8")).toBe("tidal-asar");
		await expect(stat(path.join(stateRoot, "build.new"))).rejects.toThrow();
	});

	test("when the archive would escape the folder it is unpacked into", async () => {
		await tidalInstall();
		await withState();
		// A Windows backslash is what can still escape, so this is the archive that has to be refused
		const zip = new JSZip();
		zip.file("package.json", JSON.stringify({ name: "luna", version: VERSION }));
		zip.file("injector.mjs", "boot");
		zip.file("luna.mjs", "core");
		zip.file("..\\escape.mjs", "escaped");
		const zipBytes = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;

		const result = await runUpdateGuard(deps(zipBytes));

		expect(result).toMatchObject({ action: "failed", reason: expect.stringMatching(/unpacked|refused/) });
		expect((await injectionState(resourcesDir)).kind).toBe("vanilla");
	});

	test("when the release list cannot be read at all", async () => {
		await tidalInstall();
		await withState();
		const d = deps(await makeZip(), undefined, {
			fetchReleases: async () => {
				throw new Error("offline");
			},
		});

		expect(await runUpdateGuard(d)).toMatchObject({ action: "failed", reason: expect.stringMatching(/could not read the releases: offline/) });
	});
});
