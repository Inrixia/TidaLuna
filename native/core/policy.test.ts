import { describe, expect, it } from "vitest";

import {
	allVersionsEntries,
	boundedCache,
	compareVersions,
	coreNativeArgsError,
	coreNativeQuestion,
	coreNativeRule,
	isCoreUrl,
	isDevUrl,
	nativesDiff,
} from "./policy";

describe("core policy", () => {
	it("tells Luna's own urls apart", () => {
		expect(isCoreUrl("https://luna/luna.lib")).toBe(true);
		expect(isCoreUrl("https://luna.example.com/x")).toBe(false);
		expect(isCoreUrl("http://luna/luna.lib")).toBe(false);
	});

	it("only treats http on host 127.0.0.1 as a dev url", () => {
		expect(isDevUrl("http://127.0.0.1:3002/Tidal Tags")).toBe(true);
		expect(isDevUrl("http://127.0.0.1/Plugin")).toBe(true);
		expect(isDevUrl("http://localhost:3000/Plugin")).toBe(false);
		expect(isDevUrl("https://127.0.0.1/Plugin")).toBe(false);
		expect(isDevUrl("http://127.0.0.1.example.com/Plugin")).toBe(false);
		expect(isDevUrl("http://127.0.0.1@example.com/Plugin")).toBe(false);
		expect(isDevUrl("not a url")).toBe(false);
	});

	it("lists added and removed native files", () => {
		expect(nativesDiff(["a", "b"], ["b", "c"])).toStrictEqual({ added: ["c"], removed: ["a"] });
		expect(nativesDiff([], [])).toStrictEqual({ added: [], removed: [] });
	});

	it("forgets the least recently used cache entries", () => {
		const cache = boundedCache<number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a");
		cache.set("c", 3);
		expect(cache.size).toBe(2);
		// "a" was used after "b", so "b" is the oldest
		expect(cache.get("b")).toBe(undefined);
		expect(cache.get("a")).toBe(1);
		expect(cache.get("c")).toBe(3);
	});
});

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

describe("core policy: native answers for all versions", () => {
	it("finds the plugin's allowUpdates answers, by checked url else the named one", () => {
		const URL = "https://example.com/plugin";
		const natives = {
			a: { url: URL, fileName: "a.native.ts", answer: "allowUpdates" },
			b: { claimedUrl: URL, fileName: "b.native.ts", answer: "allowUpdates" },
			c: { url: URL, fileName: "c.native.ts", answer: "allow" },
			d: { url: "https://example.com/other", claimedUrl: URL, fileName: "d.native.ts", answer: "allowUpdates" },
			e: { url: "https://example.com/other", fileName: "e.native.ts", answer: "allowUpdates" },
		};
		expect(allVersionsEntries(natives, URL)).toStrictEqual([
			["a", "a.native.ts"],
			["b", "b.native.ts"],
		]);
		expect(allVersionsEntries({}, URL)).toStrictEqual([]);
	});
});
