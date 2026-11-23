// Run: pnpm exec tsx --test render/src/helpers/pluginUpdates.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { createHash } from "node:crypto";

import { codeToImport, isDevUrl, nativeFileChanges, nativeFileNames, sha256Hex, updateWaitsForUser } from "./pluginUpdates";

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

const register = (file: string) => `await __ipcRenderer.invoke("__Luna.registerNative", "${file}", "export const x = 1;");`;

test("finds the native files a bundle registers", () => {
	const bundle = [
		register("discord.native.ts"),
		`const b = await __ipcRenderer.invoke( '__Luna.registerNative' , 'download.native.ts' , "code");`,
		// The same file twice is listed once
		register("discord.native.ts"),
	].join("\n");
	assert.deepEqual(nativeFileNames(bundle), ["discord.native.ts", "download.native.ts"]);
});

test("ignores bundles without native code and other channels", () => {
	assert.deepEqual(nativeFileNames(`fetch("https://example.com"); __ipcRenderer.invoke("__Luna.other", "x.native.ts", "");`), []);
});

test("unescapes the file name", () => {
	assert.deepEqual(nativeFileNames(`__ipcRenderer.invoke("__Luna.registerNative", "we\\"ird.native.ts", "");`), [`we"ird.native.ts`]);
});

test("lists the native files an update adds and removes", () => {
	const current = [register("a.native.ts"), register("b.native.ts")].join("\n");
	const update = [register("b.native.ts"), register("c.native.ts")].join("\n");
	assert.deepEqual(nativeFileChanges(current, update), {
		files: ["b.native.ts", "c.native.ts"],
		added: ["c.native.ts"],
		removed: ["a.native.ts"],
	});
	assert.deepEqual(nativeFileChanges("", ""), { files: [], added: [], removed: [] });
});
