import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { recordLunaInstalled } from "./registerSelf";
import { readLunaState } from "./lunaState";
import { writeLunaState } from "./lunaState";
import { newLunaState } from "./lunaState";

/**
 * Luna recording itself on boot.
 *
 * This is what every other piece depends on: without a record, a repair cannot tell "TIDAL updated and removed Luna" from
 * "this machine never had Luna", and refuses to act. So it has to be written by the install booting, and it has to
 * describe the install that is actually running.
 */
let dir: string;
let stateRoot: string;
let resourcesDir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-register-self-"));
	stateRoot = path.join(dir, "luna");
	resourcesDir = path.join(dir, "TIDAL", "app-2.48.0", "resources");
	await mkdir(resourcesDir, { recursive: true });
	await writeFile(path.join(resourcesDir, "original.asar"), "tidal-asar");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const record = (lunaVersion = "1.27.0") => recordLunaInstalled({ stateRoot, resourcesDir, lunaVersion });

describe("recordLunaInstalled", () => {
	test("writes the record a repair needs, describing this install", async () => {
		const result = await record();

		expect(result).toMatchObject({ recorded: true });
		const state = await readLunaState(stateRoot);
		expect(state?.lunaVersion).toBe("1.27.0");
		expect(Object.keys(state?.installs ?? {})).toEqual([resourcesDir]);
		// The TIDAL version comes from the folder the running Luna was loaded out of
		expect(state?.installs[resourcesDir]).toMatchObject({ tidalVersion: "2.48.0", asarBytes: "tidal-asar".length });
	});

	test("points at an install that is not versioned without inventing a version", async () => {
		const plain = path.join(dir, "tidal-hifi", "resources");
		await mkdir(plain, { recursive: true });
		await writeFile(path.join(plain, "original.asar"), "asar");

		await recordLunaInstalled({ stateRoot, resourcesDir: plain, lunaVersion: "1.27.0" });

		// The path carries no version, so none is claimed rather than a made up one
		expect((await readLunaState(stateRoot))?.installs[plain].tidalVersion).toBeUndefined();
	});

	test("does not rewrite a record that is already current", async () => {
		await record();
		const before = await readFile(path.join(stateRoot, "state.json"), "utf8");
		const again = await record();

		expect(again).toMatchObject({ recorded: true, reason: "already recorded for this install" });
		expect(await readFile(path.join(stateRoot, "state.json"), "utf8")).toBe(before);
	});

	test("records again when the install changed under it", async () => {
		await record();
		// A different asar is what a TIDAL update leaves behind
		await writeFile(path.join(resourcesDir, "original.asar"), "a longer tidal asar");

		expect(await record()).toMatchObject({ reason: "recorded" });
		expect((await readLunaState(stateRoot))?.installs[resourcesDir]).toMatchObject({ asarBytes: "a longer tidal asar".length });
	});

	test("records again when a different Luna is running", async () => {
		await record("1.26.0");
		await record("1.28.0");

		expect((await readLunaState(stateRoot))?.lunaVersion).toBe("1.28.0");
	});

	test("keeps what the user chose when it writes", async () => {
		await writeLunaState(stateRoot, { ...newLunaState("1.26.0"), pinnedVersion: "1.26.0", autoUpgrade: false });

		await record("1.27.0");

		expect(await readLunaState(stateRoot)).toMatchObject({ pinnedVersion: "1.26.0", autoUpgrade: false, lunaVersion: "1.27.0" });
	});

	test("refuses to record a folder that is not an installed Luna", async () => {
		// No original.asar: nothing is injected here, so there is nothing to record
		const bare = path.join(dir, "TIDAL", "app-2.49.0", "resources");
		await mkdir(bare, { recursive: true });

		expect(await recordLunaInstalled({ stateRoot, resourcesDir: bare, lunaVersion: "1.27.0" })).toMatchObject({ recorded: false });
		expect(await readLunaState(stateRoot)).toBeUndefined();
	});

	test("never throws on the boot path, even when it cannot write", async () => {
		// A state root that is a file, so it cannot be made into a folder
		await writeFile(path.join(dir, "blocked"), "");

		const result = await recordLunaInstalled({ stateRoot: path.join(dir, "blocked"), resourcesDir, lunaVersion: "1.27.0" });

		expect(result.recorded).toBe(false);
		expect(result.reason).toMatch(/could not write the record/);
	});
});
