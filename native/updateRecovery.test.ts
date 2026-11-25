import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { RUNNER_FILE } from "./publishRunner";
import { newLunaState, readLunaState, writeLunaState } from "./lunaState";
import { applyRecordedDecision, decideUpdateRecovery, recoveryStatus } from "./updateRecovery";

/**
 * Automatic recovery is opt-in, so the property worth pinning is that nothing is registered until the user says yes.
 *
 * A logon task is a persistent change to someone's machine, and "we never asked, so it must be fine" is how a client mod
 * ends up installing itself a daemon.
 */
let dir: string;
let stateRoot: string;
let home: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-recovery-"));
	stateRoot = path.join(dir, "luna");
	home = path.join(dir, "home");
	await mkdir(stateRoot, { recursive: true });
	// What a normal start leaves behind before anything is asked
	await writeFile(path.join(stateRoot, RUNNER_FILE), "console.log('entry')");
	await writeLunaState(stateRoot, newLunaState("1.27.0"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const fakeRun = () => {
	const calls: { command: string; args: string[] }[] = [];
	const run = vi.fn(async (command: string, args: string[]) => {
		calls.push({ command, args });
		return { code: 0, stdout: "" };
	});
	return { run, calls };
};

const deps = (run: ReturnType<typeof fakeRun>["run"]) => ({
	stateRoot,
	platform: "linux" as const,
	home,
	electron: "/opt/tidal-hifi/tidal-hifi",
	run,
});

describe("recoveryStatus", () => {
	test("says nothing has been decided on a machine that was never asked", async () => {
		expect(await recoveryStatus(stateRoot)).toEqual({ decision: undefined, mechanism: undefined });
	});
});

describe("applyRecordedDecision on boot", () => {
	test("registers nothing when the user has not been asked", async () => {
		const { run, calls } = fakeRun();

		expect(await applyRecordedDecision(deps(run))).toBeUndefined();
		// Opt-in means silence is not a yes
		expect(calls).toEqual([]);
	});

	test("registers nothing when the user declined", async () => {
		await writeLunaState(stateRoot, { ...newLunaState("1.27.0"), updateRecovery: "declined" });
		const { run, calls } = fakeRun();

		expect(await applyRecordedDecision(deps(run))).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("completes a yes that could not be registered when it was given", async () => {
		await writeLunaState(stateRoot, { ...newLunaState("1.27.0"), updateRecovery: "enabled" });
		const { run, calls } = fakeRun();

		expect(await applyRecordedDecision(deps(run))).toMatchObject({ installed: true, mechanism: "systemd" });
		expect(calls.length).toBeGreaterThan(0);
		expect((await readLunaState(stateRoot))?.schedule).toMatchObject({ mechanism: "systemd" });
	});

	test("does not register a second time once it is recorded", async () => {
		await writeLunaState(stateRoot, {
			...newLunaState("1.27.0"),
			updateRecovery: "enabled",
			schedule: { mechanism: "systemd", installedAt: "2026-01-01T00:00:00.000Z" },
		});
		const { run, calls } = fakeRun();

		expect(await applyRecordedDecision(deps(run))).toBeUndefined();
		expect(calls).toEqual([]);
	});
});

describe("decideUpdateRecovery", () => {
	test("a yes registers it and records how", async () => {
		const { run, calls } = fakeRun();

		const outcome = await decideUpdateRecovery({ ...deps(run), decision: "enabled" });

		expect(outcome).toMatchObject({ decision: "enabled", installed: true, mechanism: "systemd" });
		expect(calls).toContainEqual({ command: "systemctl", args: ["--user", "enable", "--now", "luna-update-guard.timer"] });
		const state = await readLunaState(stateRoot);
		expect(state).toMatchObject({ updateRecovery: "enabled", schedule: { mechanism: "systemd" } });
	});

	test("a no records the answer and takes nothing off the machine", async () => {
		const { run, calls } = fakeRun();

		const outcome = await decideUpdateRecovery({ ...deps(run), decision: "declined" });

		expect(outcome).toMatchObject({ decision: "declined", installed: false });
		expect((await readLunaState(stateRoot))?.updateRecovery).toBe("declined");
		// Disabling something that was never enabled is a no-op, not an error
		expect(calls.every(({ command }) => command === "systemctl")).toBe(true);
	});

	test("changing your mind from yes to no takes the task back off the machine", async () => {
		await decideUpdateRecovery({ ...deps(fakeRun().run), decision: "enabled" });
		const { run, calls } = fakeRun();

		const outcome = await decideUpdateRecovery({ ...deps(run), decision: "declined" });

		expect(outcome).toMatchObject({ decision: "declined", installed: false });
		expect(calls).toContainEqual({ command: "systemctl", args: ["--user", "disable", "--now", "luna-update-guard.timer"] });
		const state = await readLunaState(stateRoot);
		expect(state?.schedule).toBeUndefined();
		expect(state?.updateRecovery).toBe("declined");
	});

	test("keeps the answer even when registering failed, so the next start can retry", async () => {
		const run = vi.fn(async () => ({ code: 1, stdout: "" }));

		const outcome = await decideUpdateRecovery({ ...deps(run as never), decision: "enabled" });

		expect(outcome.installed).toBe(false);
		const state = await readLunaState(stateRoot);
		expect(state?.updateRecovery).toBe("enabled");
		expect(state?.schedule).toBeUndefined();
	});

	test("refuses on a machine Luna does not think it is installed on", async () => {
		const empty = path.join(dir, "no-state");
		await mkdir(empty, { recursive: true });

		const outcome = await decideUpdateRecovery({ stateRoot: empty, platform: "linux", home, electron: "/x", decision: "enabled" });

		expect(outcome).toMatchObject({ installed: false, reason: expect.stringMatching(/no record of being installed/) });
		await expect(readFile(path.join(empty, "state.json"), "utf8")).rejects.toThrow();
	});
});
