import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { forgetLunaState, newLunaState, readLunaState, recordInstall, writeLunaState } from "./lunaState";
import { planUpdate, type Observation } from "./updatePlan";
import type { InjectionState, TidalInstall } from "./tidalInstall";

/**
 * The decision an unattended run makes after a TIDAL update.
 *
 * The important cases are the two that look identical on disk: a TIDAL update that replaced Luna (act) and a machine
 * that never had Luna (do nothing). Everything else is about not fighting the user's own setup.
 */
let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-update-plan-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const install = (version?: string): TidalInstall => ({
	appDir: path.join(dir, version === undefined ? "tidal-hifi" : `app-${version}`),
	resourcesDir: path.join(dir, version === undefined ? "tidal-hifi" : `app-${version}`, "resources"),
	version,
});

const asar = (bytes = 100, mtimeMs = 1000) => ({ bytes, mtimeMs });

const injected = (
	recorded: { lunaVersion?: string; tidalVersion?: string; asar?: { bytes: number; mtimeMs: number } } = {},
): InjectionState => ({
	kind: "injected",
	install: {
		lunaVersion: recorded.lunaVersion ?? "1.26.0",
		tidalVersion: recorded.tidalVersion,
		asarBytes: recorded.asar?.bytes ?? 100,
		asarMtimeMs: recorded.asar?.mtimeMs ?? 1000,
		injectedAt: "2026-01-01T00:00:00.000Z",
	},
});

const observe = (
	injection: InjectionState,
	options: { version?: string; currentAsar?: { bytes: number; mtimeMs: number } } = {},
): Observation => ({
	install: install(options.version),
	injection,
	// The asar TIDAL has now; the tests that matter are the ones where it differs from what the marker recorded
	currentAsar:
		options.currentAsar ??
		(injection.kind === "injected" ? { bytes: injection.install.asarBytes, mtimeMs: injection.install.asarMtimeMs } : undefined),
});

const state = () => {
	const base = newLunaState("1.26.0");
	return recordInstall(base, install("2.48.0").resourcesDir, {
		tidalVersion: "2.48.0",
		asarBytes: 100,
		asarMtimeMs: 1000,
		injectedAt: "2026-01-01T00:00:00.000Z",
		lunaVersion: "1.26.0",
	});
};

describe("planUpdate", () => {
	test("does nothing when no TIDAL install was found", () => {
		expect(planUpdate(state(), [])).toMatchObject({ action: "none", reason: expect.stringMatching(/no TIDAL install/) });
	});

	test("does nothing when Luna was never installed here, even though TIDAL is vanilla", () => {
		// The case that matters: a vanilla install looks exactly like one an update just replaced
		const plan = planUpdate(undefined, [observe({ kind: "vanilla", hasAsar: true }, { version: "2.48.0" })]);

		expect(plan).toMatchObject({ action: "none" });
		expect(plan.action === "none" && plan.reason).toMatch(/no record of being installed/);
	});

	test("installs into a version folder a TIDAL update just added", () => {
		const plan = planUpdate(state(), [observe({ kind: "vanilla", hasAsar: true }, { version: "2.49.0" })]);

		expect(plan).toMatchObject({ action: "inject", install: { version: "2.49.0" } });
	});

	test("does nothing when Luna is already installed for that install", () => {
		expect(planUpdate(state(), [observe(injected({ tidalVersion: "2.48.0" }), { version: "2.48.0" })])).toMatchObject({ action: "none" });
	});

	test("reinstalls when TIDAL's asar changed under an install with no version in its path", () => {
		// A flatpak or /opt install: nothing about the path says it changed, the asar does
		const plan = planUpdate(state(), [observe(injected({ tidalVersion: "2.48.0" }), { currentAsar: asar(200, 2000) })]);

		expect(plan).toMatchObject({ action: "inject" });
		expect(plan.action === "inject" && plan.reason).toMatch(/asar changed/);
	});

	test("reinstalls when the marker says a different TIDAL version", () => {
		const plan = planUpdate(state(), [observe(injected({ tidalVersion: "2.47.0" }), { version: "2.48.0", currentAsar: asar(200, 2000) })]);

		expect(plan).toMatchObject({ action: "inject" });
		expect(plan.action === "inject" && plan.reason).toMatch(/TIDAL 2\.47\.0/);
	});

	test("reinstalls when Luna is installed but TIDAL's asar is gone", () => {
		expect(planUpdate(state(), [{ install: install("2.48.0"), injection: injected(), currentAsar: undefined }])).toMatchObject({
			action: "inject",
		});
	});

	test("leaves a resources/app it did not write alone", () => {
		const plan = planUpdate(state(), [
			observe({ kind: "foreign", reason: "resources/app exists but holds no Luna install marker" }, { version: "2.48.0" }),
		]);

		expect(plan).toMatchObject({ action: "none" });
		expect(plan.action === "none" && plan.reason).toMatch(/not\b|marker/);
	});

	test("leaves a folder that is not a usable TIDAL install alone", () => {
		expect(planUpdate(state(), [observe({ kind: "empty" }, { version: "2.48.0" })])).toMatchObject({ action: "none" });
	});

	test("only looks at the newest install, since that is the one TIDAL launches", () => {
		const older = observe({ kind: "vanilla", hasAsar: true }, { version: "2.47.0" });
		const newest = observe(injected({ tidalVersion: "2.48.0" }), { version: "2.48.0" });

		expect(planUpdate(state(), [newest, older])).toMatchObject({ action: "none" });
	});
});

describe("lunaState", () => {
	test("has no state until one is written", async () => {
		expect(await readLunaState(dir)).toBeUndefined();
	});

	test("round-trips what was written", async () => {
		const written = state();
		await writeLunaState(dir, written);

		const read = await readLunaState(dir);
		expect(read).toEqual(written);
	});

	test("treats an unusable state as no state, so nothing is acted on", async () => {
		await writeLunaState(dir, state());
		await rm(path.join(dir, "state.json"));
		const { writeFile } = await import("fs/promises");
		await writeFile(path.join(dir, "state.json"), "{ not json");

		expect(await readLunaState(dir)).toBeUndefined();
	});

	test("fills in what an older state file lacks", async () => {
		const { writeFile } = await import("fs/promises");
		await writeFile(path.join(dir, "state.json"), JSON.stringify({ installedAt: "2026-01-01T00:00:00.000Z", lunaVersion: "1.20.0" }));

		const read = await readLunaState(dir);
		expect(read).toMatchObject({ lunaVersion: "1.20.0", autoUpgrade: true, installs: {} });
	});

	test("forgetting it is what makes the next update leave Luna alone", async () => {
		await writeLunaState(dir, state());
		await forgetLunaState(dir);

		expect(await readLunaState(dir)).toBeUndefined();
		// And the file itself is gone, not just unreadable
		await expect(readFile(path.join(dir, "state.json"), "utf8")).rejects.toThrow();
	});

	test("records an install under the resources folder it went into, keeping when Luna was first seen", () => {
		const base = { ...newLunaState("1.20.0"), installedAt: "2026-01-01T00:00:00.000Z" };
		const recorded = recordInstall(base, "/tidal/resources", {
			tidalVersion: "2.48.0",
			asarBytes: 1,
			asarMtimeMs: 2,
			injectedAt: "2026-02-02T00:00:00.000Z",
			lunaVersion: "1.21.0",
		});

		expect(recorded.lunaVersion).toBe("1.21.0");
		expect(Object.keys(recorded.installs)).toEqual(["/tidal/resources"]);
		// The first time Luna recorded itself, not the time of this install
		expect(recorded.installedAt).toBe("2026-01-01T00:00:00.000Z");
	});
});

describe("planUpdate: a user who removes Luna stays uninstalled", () => {
	// The asar is what tells an update from an uninstall: TIDAL moved vs the user deleted Luna's folder
	test("forgets Luna removed from an install it recorded, with TIDAL unchanged", () => {
		const plan = planUpdate(state(), [observe({ kind: "vanilla", hasAsar: true }, { version: "2.48.0", currentAsar: asar(100, 1000) })]);

		expect(plan).toMatchObject({ action: "forget" });
	});

	test("puts Luna back when TIDAL changed that same install", () => {
		// In place update (a flatpak or /opt install): the asar moved, so this is an update and not a removal
		const plan = planUpdate(state(), [observe({ kind: "vanilla", hasAsar: true }, { version: "2.48.0", currentAsar: asar(200, 2000) })]);

		expect(plan).toMatchObject({ action: "inject" });
	});

	test("puts Luna back into a new version folder", () => {
		// A new app-<version> has no record of its own, which is an update rather than the user removing anything
		const plan = planUpdate(state(), [observe({ kind: "vanilla", hasAsar: true }, { version: "2.49.0" })]);

		expect(plan).toMatchObject({ action: "inject" });
	});

	test("puts Luna back when that install was never recorded", () => {
		const plan = planUpdate(state(), [observe({ kind: "vanilla", hasAsar: true }, { version: "2.48.0" })]);

		expect(plan).toMatchObject({ action: "inject" });
	});
});
