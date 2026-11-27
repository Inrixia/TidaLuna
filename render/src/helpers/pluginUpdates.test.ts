
import { expect, test } from "vitest";

import { createHash } from "node:crypto";

import { codeToImport, isDevUrl, sha256Hex, updateWaitsForUser } from "./pluginUpdates";

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
