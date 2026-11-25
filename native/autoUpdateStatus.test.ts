import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { parseRunLog, updateGuardStatus } from "./autoUpdateStatus";
import { newLunaState, writeLunaState } from "./lunaState";

/**
 * What the settings page can show, which is all it can do: the page reads this and cannot start a run through it.
 */
let stateRoot: string;

beforeEach(async () => {
	stateRoot = await mkdtemp(path.join(os.tmpdir(), "luna-guard-status-"));
});
afterEach(async () => {
	await rm(stateRoot, { recursive: true, force: true });
});

const writeLog = async (...lines: string[]) => {
	await mkdir(path.join(stateRoot, "log"), { recursive: true });
	await writeFile(path.join(stateRoot, "log", "update-guard.log"), `${lines.join("\n")}\n`);
};

describe("parseRunLog", () => {
	test("reads the lines the run writes", () => {
		expect(parseRunLog("2026-01-01T00:00:00.000Z installed: Luna 1.27.0 installed for TIDAL 2.48.0")).toEqual([
			{ at: "2026-01-01T00:00:00.000Z", action: "installed", reason: "Luna 1.27.0 installed for TIDAL 2.48.0" },
		]);
	});

	test("keeps a line it cannot parse rather than dropping the log for it", () => {
		expect(parseRunLog("something unexpected")).toEqual([{ at: "", action: "unreadable", reason: "something unexpected" }]);
	});

	test("ignores blank lines", () => {
		expect(parseRunLog("\n\n2026-01-01T00:00:00.000Z none: nothing to do\n\n")).toHaveLength(1);
	});
});

describe("updateGuardStatus", () => {
	test("says nothing was installed when Luna has no record here", async () => {
		const status = await updateGuardStatus(stateRoot);

		expect(status.installed).toBeUndefined();
		expect(status.lastRun).toBeUndefined();
		expect(status.recent).toEqual([]);
	});

	test("shows what Luna recorded about itself", async () => {
		await writeLunaState(stateRoot, { ...newLunaState("1.26.0"), pinnedVersion: "1.26.0" });

		const status = await updateGuardStatus(stateRoot);

		expect(status.installed).toMatchObject({ lunaVersion: "1.26.0", autoUpgrade: true, pinnedVersion: "1.26.0" });
	});

	test("shows the last run and the recent ones, newest last", async () => {
		await writeLog(
			"2026-01-01T00:00:00.000Z none: TIDAL 2.48.0 already has Luna 1.26.0 for this install",
			"2026-01-02T00:00:00.000Z installed: Luna 1.27.0 installed for TIDAL 2.48.0",
		);

		const status = await updateGuardStatus(stateRoot);

		expect(status.lastRun).toMatchObject({ action: "installed" });
		expect(status.recent.map(({ action }) => action)).toEqual(["none", "installed"]);
	});

	test("keeps the recent list short, since it is for a settings card", async () => {
		await writeLog(...Array.from({ length: 40 }, (_, index) => `2026-01-01T00:00:0${index % 10}.000Z none: run ${index}`));

		const status = await updateGuardStatus(stateRoot);

		expect(status.recent).toHaveLength(20);
		// The newest are the ones kept
		expect(status.recent.at(-1)?.reason).toBe("run 39");
		expect(status.lastRun?.reason).toBe("run 39");
	});
});
