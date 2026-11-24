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
		assert.equal(isCoreUrl("https://luna/luna.lib"), true);
		assert.equal(isCoreUrl("https://luna.example.com/x"), false);
		assert.equal(isCoreUrl("http://luna/luna.lib"), false);
	});

	it("only treats http on host 127.0.0.1 as a dev url", () => {
		assert.equal(isDevUrl("http://127.0.0.1:3002/Tidal Tags"), true);
		assert.equal(isDevUrl("http://127.0.0.1/Plugin"), true);
		assert.equal(isDevUrl("http://localhost:3000/Plugin"), false);
		assert.equal(isDevUrl("https://127.0.0.1/Plugin"), false);
		assert.equal(isDevUrl("http://127.0.0.1.example.com/Plugin"), false);
		assert.equal(isDevUrl("http://127.0.0.1@example.com/Plugin"), false);
		assert.equal(isDevUrl("not a url"), false);
	});

	it("lists added and removed native files", () => {
		assert.deepEqual(nativesDiff(["a", "b"], ["b", "c"]), { added: ["c"], removed: ["a"] });
		assert.deepEqual(nativesDiff([], []), { added: [], removed: [] });
	});

	it("forgets the least recently used cache entries", () => {
		const cache = boundedCache<number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a");
		cache.set("c", 3);
		assert.equal(cache.size, 2);
		// "a" was used after "b", so "b" is the oldest
		assert.equal(cache.get("b"), undefined);
		assert.equal(cache.get("a"), 1);
		assert.equal(cache.get("c"), 3);
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
		assert.deepEqual(allVersionsEntries(natives, URL), [
			["a", "a.native.ts"],
			["b", "b.native.ts"],
		]);
		assert.deepEqual(allVersionsEntries({}, URL), []);
	});
});
