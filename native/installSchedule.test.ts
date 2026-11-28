import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { RUNNER_FILE } from "./publishRunner";
import { installSchedule, schedulePathsFor } from "./installSchedule";

/**
 * Luna registering the run that puts it back.
 *
 * Two properties are worth more than the rest: it never escalates (a client mod asking for admin rights to keep itself
 * patched is a good reason to refuse), and it only touches the user's own folders.
 */
let dir: string;
let stateRoot: string;
let home: string;
const ELECTRON = "C:\\Users\\a\\AppData\\Local\\TIDAL\\app-2.48.0\\TIDAL.exe";

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-install-schedule-"));
	stateRoot = path.join(dir, "luna");
	home = path.join(dir, "home");
	await mkdir(stateRoot, { recursive: true });
	// What publishRunner leaves behind on a normal start
	await writeFile(path.join(stateRoot, RUNNER_FILE), "console.log('entry')");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Records every command, and answers as the platform would */
const fakeRun = (code = 0) => {
	const calls: { command: string; args: string[] }[] = [];
	const run = vi.fn(async (command: string, args: string[]) => {
		calls.push({ command, args });
		return { code, stdout: "" };
	});
	return { run, calls };
};

const install = (platform: NodeJS.Platform, run: ReturnType<typeof fakeRun>["run"]) =>
	installSchedule({ platform, stateRoot, home, electron: ELECTRON, run });

describe("installSchedule on Windows", () => {
	test("registers a task that calls the wrapper, as the user and without elevation", async () => {
		const { run, calls } = fakeRun();

		const outcome = await install("win32", run);

		expect(outcome).toMatchObject({ installed: true, mechanism: "schtasks" });
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("schtasks");
		// /Create with the definition, replaced if it exists, named so it can be found again
		expect(calls[0].args).toContain("/Create");
		expect(calls[0].args).toContain("/F");
		expect(calls[0].args[calls[0].args.indexOf("/TN") + 1]).toBe("Luna TIDAL update check");
	});

	test("never asks for elevation", async () => {
		const { run, calls } = fakeRun();

		await install("win32", run);

		const commands = calls.map(({ command, args }) => `${command} ${args.join(" ")}`).join(" | ");
		expect(commands).not.toMatch(/sudo|pkexec|runas|RunLevel.*Highest/i);
	});

	test("writes a wrapper that resolves the TIDAL installed at run time", async () => {
		const { wrapper } = schedulePathsFor({ platform: "win32", stateRoot, home });

		await install("win32", fakeRun().run);

		const contents = await readFile(wrapper, "utf8");
		expect(contents).toContain("$env:ELECTRON_RUN_AS_NODE = 1");
		expect(contents).toContain("Get-ChildItem $root -Directory -Filter 'app-*'");
		expect(contents).toContain(path.join(stateRoot, RUNNER_FILE));
	});

	test("says so when the platform refuses, instead of pretending", async () => {
		const outcome = await install("win32", fakeRun(1).run);

		expect(outcome.installed).toBe(false);
		expect(outcome.reason).toMatch(/schtasks could not register/);
	});
});

describe("installSchedule on Linux", () => {
	test("enables a systemd user timer, not a system one", async () => {
		const { run, calls } = fakeRun();

		const outcome = await install("linux", run);

		expect(outcome).toMatchObject({ installed: true, mechanism: "systemd" });
		expect(calls[0]).toEqual({ command: "systemctl", args: ["--user", "daemon-reload"] });
		expect(calls[1]).toEqual({ command: "systemctl", args: ["--user", "enable", "--now", "luna-update-guard.timer"] });
	});

	test("writes the units under the user's config, which needs no rights", async () => {
		await install("linux", fakeRun().run);

		const unitDir = path.join(home, ".config/systemd/user");
		expect(await readFile(path.join(unitDir, "luna-update-guard.timer"), "utf8")).toContain("OnStartupSec=1min");
		expect(await readFile(path.join(unitDir, "luna-update-guard.service"), "utf8")).toContain("Type=oneshot");
	});

	test("nothing it runs needs a password", async () => {
		const { run, calls } = fakeRun();

		await install("linux", run);

		expect(calls.every(({ command }) => command === "systemctl")).toBe(true);
	});
});

describe("installSchedule on macOS", () => {
	test("loads a LaunchAgent for the user", async () => {
		const { run, calls } = fakeRun();

		const outcome = await install("darwin", run);

		expect(outcome).toMatchObject({ installed: true, mechanism: "launchd" });
		expect(calls[0].command).toBe("launchctl");
		const plist = path.join(home, "Library/LaunchAgents/dev.luna.update-guard.plist");
		expect(await readFile(plist, "utf8")).toContain("RunAtLoad");
	});
});

describe("installSchedule refuses what it should", () => {
	test("does nothing when the run has not been published yet", async () => {
		await rm(path.join(stateRoot, RUNNER_FILE));
		const { run, calls } = fakeRun();

		const outcome = await install("win32", run);

		expect(outcome.installed).toBe(false);
		expect(outcome.reason).toMatch(/not at .* yet/);
		// Nothing was registered, so a half setup cannot be left behind
		expect(calls).toEqual([]);
	});

	test("reports a path it cannot write rather than throwing", async () => {
		const { run } = fakeRun();
		// A home that is a file, so the unit directory cannot be made
		const blocked = path.join(dir, "blocked-home");
		await writeFile(blocked, "");

		const outcome = await installSchedule({ platform: "linux", stateRoot, home: blocked, electron: ELECTRON, run });

		expect(outcome.installed).toBe(false);
	});
});
