// Run: pnpm exec tsx --test render/src/helpers/pluginUpdates.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { isDevUrl, nativeFileChanges, nativeFileNames, updateWaitsForUser } from "./pluginUpdates";

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

const register =(file: string) => `await __ipcRenderer.invoke("__Luna.registerNative", "${file}", "export const x = 1;");`;

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
