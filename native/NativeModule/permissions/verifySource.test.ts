import { createHash } from "crypto";

import { describe, expect, test } from "vitest";

import { nativeFilesOf } from "./verifySource";

const sha256 = (code: string) => createHash("sha256").update(code, "utf8").digest("hex");

const BT = "`";
const backtick = (text: string) => `${BT}${text}${BT}`;

/** A registration as build/plugins/lunaNativePlugin.ts emits it: the code is a JSON.stringify'd string literal */
const emittedRegister = (fileName: string, code: string) =>
	`const channel = await __ipcRenderer.invoke("__Luna.registerNative", "${fileName}", ${JSON.stringify(code)});\n` +
	`if (channel === undefined) throw new Error("Failed to register native module ${fileName}");\n` +
	`export const doThing = (...args) => __ipcRenderer.invoke(channel, "doThing", ...args);`;

describe("nativeFilesOf", () => {
	test("reads the code a built bundle registers, and hashes the code it unescapes", () => {
		const code = 'module.exports = {\n\tgreet: () => "hi",\n\tdir: "C:\\\\temp",\n};\n';
		const files = nativeFilesOf(emittedRegister("lib.native.js", code));
		expect([...files]).toEqual([["lib.native.js", sha256(code)]]);
	});

	test("reads single quoted arguments", () => {
		const files = nativeFilesOf(`__ipcRenderer.invoke('__Luna.registerNative', 'a.native.js', 'module.exports = 1')`);
		expect([...files]).toEqual([["a.native.js", sha256("module.exports = 1")]]);
	});

	test("reads template literals that interpolate nothing", () => {
		const bundle = `__ipcRenderer.invoke(${backtick("__Luna.registerNative")}, ${backtick("a.native.js")}, ${backtick("module.exports = 1")})`;
		expect([...nativeFilesOf(bundle)]).toEqual([["a.native.js", sha256("module.exports = 1")]]);
	});

	test("reads escaped quotes in the code as the character they stand for", () => {
		const bundle = `__ipcRenderer.invoke("__Luna.registerNative", "a.native.js", ${JSON.stringify('const s = "hi"')})`;
		const hash = nativeFilesOf(bundle).get("a.native.js");
		expect(hash).toBe(sha256('const s = "hi"'));
		expect(hash).not.toBe(sha256('const s = \\"hi\\"'));
	});

	test("reads escaped backslashes in the code as one character", () => {
		const code = "const dir = 'C:\\temp';";
		expect(nativeFilesOf(emittedRegister("a.native.js", code)).get("a.native.js")).toBe(sha256(code));
	});

	test("allows whitespace and newlines between the arguments", () => {
		const bundle = `__ipcRenderer.invoke(\n\t"__Luna.registerNative" ,\n\t"a.native.js"\n\t,\n\n\t"module.exports = 1"\n);`;
		expect([...nativeFilesOf(bundle)]).toEqual([["a.native.js", sha256("module.exports = 1")]]);
	});

	test("compares file names after unescaping them", () => {
		const bundle = `__ipcRenderer.invoke("__Luna.registerNative", "a\\u002enative.js", "code")`;
		expect([...nativeFilesOf(bundle).keys()]).toEqual(["a.native.js"]);
	});

	test("a registration with empty code is the hash of the empty string", () => {
		expect(nativeFilesOf(`__ipcRenderer.invoke("__Luna.registerNative", "a.native.js", "")`).get("a.native.js")).toBe(sha256(""));
	});

	test("reads every file a bundle registers", () => {
		const bundle = `${emittedRegister("lib.native.js", "first code")}\n${emittedRegister("other.native.js", "second code")}`;
		const files = nativeFilesOf(bundle);
		expect([...files]).toEqual([
			["lib.native.js", sha256("first code")],
			["other.native.js", sha256("second code")],
		]);
	});

	test("the same code under two names has the same hash", () => {
		const files = nativeFilesOf(`${emittedRegister("a.native.js", "code")}\n${emittedRegister("b.native.js", "code")}`);
		expect(files.get("a.native.js")).toBe(files.get("b.native.js"));
	});

	test.each(["", "const x = 1;\n", 'export const f = () => "hi";'])("finds nothing in a bundle without registrations (%#)", (bundle) => {
		expect(nativeFilesOf(bundle).size).toBe(0);
	});

	test("ignores invokes that are not registrations", () => {
		const bundle = `
			__ipcRenderer.invoke("__Luna.registerNative.other", "a.native.js", "code");
			__ipcRenderer.invoke("__Luna.unregisterNative", "a.native.js", "code");
			__ipcRenderer.invoke(channel, "default", ...args);
			ipcRenderer.invoke("__Luna.registerNative", "a.native.js", "code");
		`;
		expect(nativeFilesOf(bundle).size).toBe(0);
	});

	test("skips a registration whose file name is not a literal", () => {
		expect(nativeFilesOf(`__ipcRenderer.invoke("__Luna.registerNative", fileName, "code")`).size).toBe(0);
	});

	test("skips a registration whose code is not a literal", () => {
		expect(nativeFilesOf(`__ipcRenderer.invoke("__Luna.registerNative", "a.native.js", code)`).size).toBe(0);
	});

	test("skips a template literal that interpolates the code, it is not a single literal token", () => {
		const bundle = `__ipcRenderer.invoke("__Luna.registerNative", "a.native.js", ${backtick("module.exports = ${value}")})`;
		expect(nativeFilesOf(bundle).size).toBe(0);
	});

	test("skips a template literal that interpolates the file name", () => {
		const bundle = `__ipcRenderer.invoke("__Luna.registerNative", ${backtick("a.${name}.js")}, "code")`;
		expect(nativeFilesOf(bundle).size).toBe(0);
	});

	test("skips a registration without code", () => {
		expect(nativeFilesOf(`__ipcRenderer.invoke("__Luna.registerNative", "a.native.js")`).size).toBe(0);
	});

	test("skips a registration whose arguments are not separated by a comma", () => {
		expect(nativeFilesOf(`__ipcRenderer.invoke("__Luna.registerNative", "a.native.js" "module.exports = 1")`).size).toBe(0);
	});
});
