// Run: pnpm exec tsx --test render/src/helpers/nativeFileNames.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { nativeFileNames } from "./nativeFileNames";

test("finds the native files a bundle registers", () => {
	const bundle = [
		`const a = await __ipcRenderer.invoke("__Luna.registerNative", "discord.native.ts", "export const x = 1;", undefined);`,
		`const b = await __ipcRenderer.invoke( '__Luna.registerNative' , 'download.native.ts' , "code");`,
		// The same file twice is listed once
		`const c = await __ipcRenderer.invoke("__Luna.registerNative", "discord.native.ts", "export const x = 2;");`,
	].join("\n");
	assert.deepEqual(nativeFileNames(bundle), ["discord.native.ts", "download.native.ts"]);
});

test("ignores bundles without native code and other channels", () => {
	assert.deepEqual(nativeFileNames(`fetch("https://example.com"); __ipcRenderer.invoke("__Luna.other", "x.native.ts", "");`), []);
});

test("unescapes the file name", () => {
	assert.deepEqual(nativeFileNames(`__ipcRenderer.invoke("__Luna.registerNative", "we\\"ird.native.ts", "");`), [`we"ird.native.ts`]);
});
