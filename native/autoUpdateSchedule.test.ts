import { describe, expect, test } from "vitest";

import { launchAgentPlist, systemdUnits, windowsTaskXml, wrapperFor, wrapperName } from "./autoUpdateSchedule";

/**
 * The artifacts that start the unattended run.
 *
 * These are text because registering a logon task or a systemd unit is a change to someone's machine: it should be
 * generated, shown and installed deliberately. What is worth pinning is the content — that the run is a scheduled one
 * rather than something TIDAL or the page starts, that it does not need admin, and that a path with a space survives.
 */
const paths = { electron: "/opt/tidal-hifi/tidal-hifi", script: "/home/a/.local/share/tidaluna/autoUpdate.mjs" };

describe("wrapperFor", () => {
	test("sets ELECTRON_RUN_AS_NODE, which is what makes TIDAL's Electron a Node", () => {
		expect(wrapperFor("linux", paths)).toContain("ELECTRON_RUN_AS_NODE=1");
		expect(wrapperFor("win32", paths)).toContain("$env:ELECTRON_RUN_AS_NODE = 1");
	});

	test("runs the built entry point with the Electron binary it was given", () => {
		const wrapper = wrapperFor("linux", paths);

		expect(wrapper).toContain(paths.electron);
		expect(wrapper).toContain(paths.script);
		expect(wrapper.startsWith("#!/bin/sh")).toBe(true);
	});

	test("keeps a path with a space in one piece", () => {
		const spaces = { electron: "C:\\Program Files\\TIDAL\\app-2.48.0\\TIDAL.exe", script: "C:\\Users\\a user\\luna\\autoUpdate.mjs" };
		const wrapper = wrapperFor("win32", spaces);

		// PowerShell single-quoted literals, which is the only quoting that survives a space and a backslash
		expect(wrapper).toContain(`$root = 'C:\\Program Files\\TIDAL'`);
		expect(wrapper).toContain(`'C:\\Users\\a user\\luna\\autoUpdate.mjs'`);
	});

	test("finds the TIDAL that is installed when it runs, not the one that was installed when it was written", () => {
		// The whole point: TIDAL keeps one app-<version> folder per release, so a baked-in path points at a folder the next
		// update replaces. The wrapper has to resolve it again on every run
		const wrapper = wrapperFor("win32", {
			electron: "C:\\Users\\a\\AppData\\Local\\TIDAL\\app-2.48.0\\TIDAL.exe",
			script: "C:\\luna\\autoUpdate.mjs",
		});

		expect(wrapper).toContain("Get-ChildItem $root -Directory -Filter 'app-*'");
		expect(wrapper).toContain("-Descending");
		expect(wrapper).not.toContain("app-2.48.0\\TIDAL.exe");
	});

	test("does nothing when it cannot find an install, rather than failing the schedule", () => {
		expect(wrapperFor("win32", { electron: "C:\\TIDAL\\app-1.0.0\\TIDAL.exe", script: "C:\\luna\\a.mjs" })).toContain("if (-not $app) { exit 0 }");
	});

	test("names the artifact per platform", () => {
		expect(wrapperName("win32")).toMatch(/\.ps1$/);
		expect(wrapperName("linux")).toMatch(/\.sh$/);
	});
});

describe("windowsTaskXml", () => {
	const xml = windowsTaskXml({ wrapper: "C:\\Users\\a\\luna\\luna-update-guard.cmd" });

	test("runs at logon, which is when the person whose TIDAL updated is there", () => {
		expect(xml).toContain("<LogonTrigger>");
		expect(xml).toContain("<Delay>PT1M</Delay>");
	});

	test("asks for no elevation: both folders the run writes are the user's own", () => {
		expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
		expect(xml).not.toContain("HighestAvailable");
	});

	test("does not start a second run over one already going, and gives up eventually", () => {
		expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
		expect(xml).toContain("<ExecutionTimeLimit>PT10M</ExecutionTimeLimit>");
	});

	test("calls the wrapper it was given", () => {
		expect(xml).toContain("<Command>C:\\Users\\a\\luna\\luna-update-guard.cmd</Command>");
	});
});

describe("systemdUnits", () => {
	const { service, timer } = systemdUnits({ wrapper: "/home/a/.local/share/tidaluna/luna-update-guard.sh" });

	test("is a user unit, so the install it repairs does not need root", () => {
		expect(service).toContain("Type=oneshot");
		expect(service).toContain("ExecStart=/home/a/.local/share/tidaluna/luna-update-guard.sh");
		// Nothing here should need privileges: a system unit would run as root and write root-owned files into the install
		expect(service).not.toContain("User=root");
		expect(service).not.toContain("PKEXEC");
	});

	test("runs once shortly after login rather than staying resident", () => {
		expect(timer).toContain("OnStartupSec=1min");
		expect(timer).toContain("WantedBy=timers.target");
	});
});

describe("launchAgentPlist", () => {
	test("runs at load, calling the wrapper", () => {
		const plist = launchAgentPlist({ wrapper: "/Users/a/Library/Application Support/luna/luna-update-guard.sh" });

		expect(plist).toContain("<key>RunAtLoad</key>");
		expect(plist).toContain("/Users/a/Library/Application Support/luna/luna-update-guard.sh");
		expect(plist).toContain("dev.luna.update-guard");
	});
});
