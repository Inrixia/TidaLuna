import { describe, expect, it } from "vitest";

import { compareVersions, coreNativeArgsError, coreNativeQuestion, coreNativeRule } from "./policy";

describe("core native rules", () => {
	it("denies or confirms the dangerous core natives", () => {
		expect(coreNativeRule("sendToRender")).toBe("deny");
		expect(coreNativeRule("update")).toBe("confirm");
		// Installs only what a confirmed update downloaded
		expect(coreNativeRule("runElevatedInstall")).toBe("allow");
		expect(coreNativeRule("startNativeDebugging")).toBe("confirm");
		expect(coreNativeRule("pkg")).toBe("allow");
	});

	it("names the version an update installs", () => {
		const [title, lines, confirmText] = coreNativeQuestion("update", ["1.2.3"]);
		expect(title).toBe("Update Luna?");
		expect(lines.join(" ")).toMatch(/1\.2\.3/);
		expect(confirmText).toBe("Update");
	});

	it("says what the native debugger opens, in plain words", () => {
		const [title, lines, confirmText] = coreNativeQuestion("startNativeDebugging", []);
		expect(title).toBe("Start native debugging?");
		expect(lines.join(" ")).toMatch(/Node inspector on TIDAL's main process/);
		expect(lines.join(" ")).toMatch(/Any program on this computer can then run code in TIDAL/);
		expect(confirmText).toBe("Start");
	});

	it("asks about a name it has no text for by that name, never with the page's words", () => {
		expect(coreNativeQuestion("somethingElse", ["x"])).toEqual(["Run somethingElse?", [], "Run"]);
	});

	it("shows the installed version and warns about a downgrade", () => {
		const [, newer] = coreNativeQuestion("update", ["1.26.0"], "1.25.0-beta");
		expect(newer.join(" ")).toMatch(/1\.25\.0-beta -> 1\.26\.0/);
		expect(newer.join(" ")).not.toMatch(/older/);
		const [, older] = coreNativeQuestion("update", ["1.24.3"], "1.25.0-beta");
		expect(older.join(" ")).toMatch(/older than the installed version/);
	});

	it("orders release versions", () => {
		expect(compareVersions("1.25.0", "1.25.0-beta") > 0).toBeTruthy();
		expect(compareVersions("1.9.0", "1.10.0") < 0).toBeTruthy();
		expect(compareVersions("1.25.0-beta.2", "1.25.0-beta.10") < 0).toBeTruthy();
		expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
		expect(compareVersions("1.25.0-beta", "1.25.0-beta")).toBe(0);
		expect(compareVersions("1.26.0", "1.25.9") > 0).toBeTruthy();
	});

	it("claims nothing about a tag that is not a version", () => {
		expect(compareVersions("latest", "1.2.3")).toBe(0);
		expect(compareVersions("1.2", "1.2.3")).toBe(0);
		expect(compareVersions("1.2.3", "nightly-2026")).toBe(0);
		const [, lines] = coreNativeQuestion("update", ["latest"], "1.25.0");
		expect(lines.join(" ")).not.toMatch(/older/);
	});

	it("refuses update arguments that would fail before asking", () => {
		expect(coreNativeArgsError("update", ["1.26.0-beta"])).toBe(undefined);
		expect(coreNativeArgsError("update", ["../other/repo"]) ?? "").toMatch(/invalid version/);
		expect(coreNativeArgsError("update", ["1.0 then restart"]) ?? "").toMatch(/invalid version/);
		expect(coreNativeArgsError("update", [["1.0.0"]]) ?? "").toMatch(/invalid version/);
		expect(coreNativeArgsError("startNativeDebugging", [])).toBe(undefined);
	});
});
