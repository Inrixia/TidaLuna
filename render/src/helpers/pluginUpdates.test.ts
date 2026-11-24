// Run: pnpm exec tsx --test render/src/helpers/pluginUpdates.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { createHash } from "node:crypto";

import {
	allowedForAllVersions,
	codeToImport,
	comparePage,
	isDevUrl,
	releasePage,
	sha256Hex,
	sourceRepo,
	updateLinks,
	updateWaitsForUser,
} from "./pluginUpdates";

const installed = { codeChanged: true, hasCode: true, isDev: false, liveReload: false, isCore: false };

test("new code for an installed plugin waits for the user", () => {
	assert.equal(updateWaitsForUser(installed), true);
});

test("unchanged code, first install, dev, live reload and core plugins don't wait", () => {
	assert.equal(updateWaitsForUser({ ...installed, codeChanged: false }), false);
	assert.equal(updateWaitsForUser({ ...installed, hasCode: false }), false);
	assert.equal(updateWaitsForUser({ ...installed, isDev: true }), false);
	assert.equal(updateWaitsForUser({ ...installed, liveReload: true }), false);
	assert.equal(updateWaitsForUser({ ...installed, isCore: true }), false);
});

test("only plugins served from 127.0.0.1 are dev plugins", () => {
	assert.equal(isDevUrl("http://127.0.0.1:3002/Tidal Tags"), true);
	assert.equal(isDevUrl("http://127.0.0.1/Plugin"), true);
	assert.equal(isDevUrl("http://127.0.0.1.example.com/Plugin"), false);
	assert.equal(isDevUrl("http://127.0.0.1@example.com/Plugin"), false);
	assert.equal(isDevUrl("https://github.com/x/releases/download/latest/Plugin"), false);
	assert.equal(isDevUrl("not a url"), false);
});

test("the imported code names the plugin's url when native code registers", () => {
	const url = "https://example.com/Plugin";
	const call = `await __ipcRenderer.invoke("__Luna.registerNative", "a.native.ts", "code");`;
	assert.equal(
		codeToImport(call, url),
		`await __ipcRenderer.invoke("__Luna.registerNativeFrom","https://example.com/Plugin", "a.native.ts", "code");`,
	);
	// The same text inside a native file's (escaped) code string stays as it is
	const inString = `const s = "__ipcRenderer.invoke(\\"__Luna.registerNative\\", x)";`;
	assert.equal(codeToImport(inString, url), inString);
});

test("sha256Hex hashes the UTF-8 text", async () => {
	assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	const text = "export const ü = '🎵';";
	assert.equal(await sha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"));
	// Same code from another url imports different text, so it hashes differently
	const code = `__ipcRenderer.invoke("__Luna.registerNative", "a.native.ts", "");`;
	assert.notEqual(await sha256Hex(codeToImport(code, "https://a/P")), await sha256Hex(codeToImport(code, "https://b/P")));
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const RELEASE = "https://github.com/Inrixia/luna-plugins/releases/download/latest/@inrixia.VolumeScroll";

test("finds the repository a plugin is built from", () => {
	assert.equal(sourceRepo({ repository: { url: "git+https://git.cafe/me/plugins.git" } }, RELEASE), "https://git.cafe/me/plugins");
	assert.equal(sourceRepo({}, RELEASE), "https://github.com/Inrixia/luna-plugins");
	assert.equal(
		sourceRepo({ homepage: "https://github.com/Inrixia/luna-plugins#VolumeScroll" }, "https://x.example/P"),
		"https://github.com/Inrixia/luna-plugins",
	);
	assert.equal(sourceRepo({ repository: { url: "javascript:alert(1)//a/b" } }, "https://x.example/P"), undefined);
	assert.equal(sourceRepo({ homepage: "https://example.com" }, "https://x.example/P"), undefined);
});

test("links the release a plugin url downloads from", () => {
	assert.equal(releasePage(RELEASE), "https://github.com/Inrixia/luna-plugins/releases/tag/latest");
	assert.equal(releasePage("https://git.cafe/me/p/releases/download/v1.2/P"), "https://git.cafe/me/p/releases/tag/v1.2");
	assert.equal(releasePage("http://127.0.0.1:3000/P"), undefined);
});

test("compares two commits only when both are known and differ", () => {
	const repo = "https://github.com/o/r";
	assert.equal(comparePage(repo, A, B), `${repo}/compare/${A}...${B}`);
	assert.equal(comparePage(repo, A, A), undefined);
	assert.equal(comparePage(repo, A, undefined), undefined);
	assert.equal(comparePage(repo, "../x", B), undefined);
	assert.equal(comparePage(undefined, A, B), undefined);
});

test("update links: commits when the builds name them, else the release", () => {
	const repo = "https://github.com/Inrixia/luna-plugins";
	assert.deepEqual(updateLinks(RELEASE, { commit: A }, { commit: B }), {
		from: `${repo}/tree/${A}`,
		to: `${repo}/tree/${B}`,
		compare: `${repo}/compare/${A}...${B}`,
	});
	assert.deepEqual(updateLinks(RELEASE, {}, {}), { from: undefined, to: `${repo}/releases/tag/latest`, compare: undefined });
	assert.deepEqual(updateLinks("https://x.example/P", {}, {}), { from: undefined, to: undefined, compare: undefined });
});

test("finds the plugin's answers allowed for all versions", () => {
	const entries = [
		{ key: "1", fileName: "a.native.ts", url: "https://x/P", answer: "allowUpdates" },
		{ key: "2", fileName: "b.native.ts", url: "https://x/P", answer: "allow" },
		{ key: "3", fileName: "c.native.ts", claimedUrl: "https://x/P", answer: "allowUpdates" },
		{ key: "4", fileName: "a.native.ts", url: "https://y/P", answer: "allowUpdates" },
	];
	assert.deepEqual(
		allowedForAllVersions(entries, "https://x/P").map(({ key }) => key),
		["1", "3"],
	);
});
