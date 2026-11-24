// Run: pnpm exec tsx --test render/src/helpers/pluginUpdates.test.ts

import { expect, test } from "vitest";

import { createHash } from "node:crypto";

import {
	allowedForAllVersions,
	codeToImport,
	comparePage,
	isDevUrl,
	releaseOf,
	sha256Hex,
	sourceRepo,
	updateLinks,
	updateWaitsForUser,
} from "./pluginUpdates";

const installed = { codeChanged: true, hasCode: true, isDev: false, liveReload: false, isCore: false };

test("new code for an installed plugin waits for the user", () => {
	expect(updateWaitsForUser(installed)).toBe(true);
});

test("unchanged code, first install, dev, live reload and core plugins don't wait", () => {
	expect(updateWaitsForUser({ ...installed, codeChanged: false })).toBe(false);
	expect(updateWaitsForUser({ ...installed, hasCode: false })).toBe(false);
	expect(updateWaitsForUser({ ...installed, isDev: true })).toBe(false);
	expect(updateWaitsForUser({ ...installed, liveReload: true })).toBe(false);
	expect(updateWaitsForUser({ ...installed, isCore: true })).toBe(false);
});

test("only plugins served from 127.0.0.1 are dev plugins", () => {
	expect(isDevUrl("http://127.0.0.1:3002/Tidal Tags")).toBe(true);
	expect(isDevUrl("http://127.0.0.1/Plugin")).toBe(true);
	expect(isDevUrl("http://127.0.0.1.example.com/Plugin")).toBe(false);
	expect(isDevUrl("http://127.0.0.1@example.com/Plugin")).toBe(false);
	expect(isDevUrl("https://github.com/x/releases/download/latest/Plugin")).toBe(false);
	expect(isDevUrl("not a url")).toBe(false);
});

test("the imported code names the plugin's url when native code registers", () => {
	const url = "https://example.com/Plugin";
	const call = `await __ipcRenderer.invoke("__Luna.registerNative", "a.native.ts", "code");`;
	expect(codeToImport(call, url)).toBe(
		`await __ipcRenderer.invoke("__Luna.registerNativeFrom","https://example.com/Plugin", "a.native.ts", "code");`,
	);
	// The same text inside a native file's (escaped) code string stays as it is
	const inString = `const s = "__ipcRenderer.invoke(\\"__Luna.registerNative\\", x)";`;
	expect(codeToImport(inString, url)).toBe(inString);
});

test("sha256Hex hashes the UTF-8 text", async () => {
	expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	const text = "export const ü = '🎵';";
	expect(await sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
	// Same code from another url imports different text, so it hashes differently
	const code = `__ipcRenderer.invoke("__Luna.registerNative", "a.native.ts", "");`;
	expect(await sha256Hex(codeToImport(code, "https://a/P"))).not.toBe(await sha256Hex(codeToImport(code, "https://b/P")));
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const RELEASE = "https://github.com/Inrixia/luna-plugins/releases/download/latest/@inrixia.VolumeScroll";
const LATEST = { tag: "latest", page: "https://github.com/Inrixia/luna-plugins/releases/tag/latest" };

test("finds the repository a plugin is built from", () => {
	expect(sourceRepo({ repository: { url: "git+https://git.cafe/me/plugins.git" } }, "https://x.example/P")).toBe("https://git.cafe/me/plugins");
	expect(sourceRepo({ repository: "https://git.cafe/me/plugins" }, "https://x.example/P")).toBe("https://git.cafe/me/plugins");
	expect(sourceRepo({ repository: "github:o/r" }, "https://x.example/P")).toBe("https://github.com/o/r");
	expect(sourceRepo({ repository: "o/r" }, "https://x.example/P")).toBe("https://github.com/o/r");
	// The release the code downloads from wins over what the package claims
	expect(sourceRepo({ repository: { url: "https://github.com/x/benign" } }, RELEASE)).toBe("https://github.com/Inrixia/luna-plugins");
	expect(sourceRepo({ repository: { url: "javascript:alert(1)//a/b" } }, "https://x.example/P")).toBe(undefined);
	expect(sourceRepo({}, "https://x.example/P")).toBe(undefined);
});

test("finds the release a plugin url downloads from", () => {
	expect(releaseOf(RELEASE)).toStrictEqual(LATEST);
	expect(releaseOf("https://git.cafe/me/p/releases/download/v1.2/P")).toStrictEqual({
		tag: "v1.2",
		page: "https://git.cafe/me/p/releases/tag/v1.2",
	});
	expect(releaseOf("https://github.com/o/r/releases/download/plugin/v1.2/P")).toStrictEqual({
		tag: "plugin/v1.2",
		page: "https://github.com/o/r/releases/tag/plugin%2Fv1.2",
	});
	expect(releaseOf("https://github.com/o/r/releases/download/%E0/P")).toBe(undefined);
	expect(releaseOf("http://127.0.0.1:3000/P")).toBe(undefined);
});

test("compares two commits only when both are known and differ", () => {
	const repo = "https://github.com/o/r";
	expect(comparePage(repo, A, B)).toBe(`${repo}/compare/${A}...${B}`);
	expect(comparePage(repo, A, A)).toBe(undefined);
	expect(comparePage(repo, A, undefined)).toBe(undefined);
	expect(comparePage(repo, "../x", B)).toBe(undefined);
	expect(comparePage(undefined, A, B)).toBe(undefined);
});

test("update links: commits when the builds name them, and the rolling release", () => {
	const repo = "https://github.com/Inrixia/luna-plugins";
	expect(updateLinks(RELEASE, { commit: A }, { commit: B, repository: { url: "https://github.com/x/benign" } })).toStrictEqual({
		from: `${repo}/commit/${A}`,
		to: `${repo}/commit/${B}`,
		compare: `${repo}/compare/${A}...${B}`,
		release: LATEST,
	});
});

test("update links: the installed version's repository wins over the update's", () => {
	const current = { repository: { url: "https://git.cafe/me/p" }, commit: A };
	const links = updateLinks("https://x.example/P", current, { repository: { url: "https://evil.example/x/y" }, commit: B });
	expect(links.compare).toBe(`https://git.cafe/me/p/compare/${A}...${B}`);
});

test("update links: a rolling release is linked as the release, a version tag as the version", () => {
	expect(updateLinks(RELEASE, {}, { version: "1.3.0" })).toStrictEqual({ from: undefined, to: undefined, compare: undefined, release: LATEST });
	const tagged = "https://github.com/o/r/releases/download/v1.3.0/P";
	expect(updateLinks(tagged, {}, { version: "1.3.0" })).toStrictEqual({
		from: undefined,
		to: "https://github.com/o/r/releases/tag/v1.3.0",
		compare: undefined,
		release: undefined,
	});
	expect(updateLinks("https://x.example/P", {}, {})).toStrictEqual({ from: undefined, to: undefined, compare: undefined, release: undefined });
});

test("finds the plugin's answers allowed for all versions", () => {
	const entries = [
		{ key: "1", fileName: "a.native.ts", url: "https://x/P", answer: "allowUpdates" },
		{ key: "2", fileName: "b.native.ts", url: "https://x/P", answer: "allow" },
		{ key: "3", fileName: "c.native.ts", claimedUrl: "https://x/P", answer: "allowUpdates" },
		{ key: "4", fileName: "a.native.ts", url: "https://y/P", answer: "allowUpdates" },
	];
	expect(allowedForAllVersions(entries, "https://x/P").map(({ key }) => key)).toStrictEqual(["1", "3"]);
});
