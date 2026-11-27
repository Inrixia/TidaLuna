import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { lunaNativePlugin } from "./lunaNativePlugin";

/**
 * `lunaNativePlugin` replaces an imported `*.native.ts` with IPC. The native file is bundled for the main process
 * (cjs, minified, node target), its code is handed to `onNativeCode` (Luna hashes core plugin native code against it)
 * and the import becomes a module that registers the code through `__Luna.registerNative` and exports one async IPC
 * stub per native export.
 *
 * Fixtures are fake plugin folders in a temp dir, built the way `build/index.ts` builds one. The emitted module is
 * evaluated with a fake `__ipcRenderer` where the stubs themselves matter, so these assert a plugin really can call
 * its native code, not just that the generated text looks right.
 */

const pkgName = "@test/plugin";

let dir: string;
let builds = 0;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-nativeplugin-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Write a fake plugin folder (path relative to the plugin root -> contents) and return the root */
const writePlugin = async (files: Record<string, string>) => {
	const root = path.join(dir, `plugin-${builds++}`);
	for (const [relativePath, contents] of Object.entries(files)) {
		const file = path.join(root, relativePath);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, contents);
	}
	return root;
};

/**
 * Build a plugin entry the way `build/index.ts` does: `write: false`, esm. `pluginEntryPoint` is the plugin entry as
 * `pluginBuildOptions` computes it (a path under the plugin folder, not the native file), given here relative to it.
 */
const buildPlugin = async (root: string, entry: string, pluginEntryPoint: string) => {
	const onNativeCode = vi.fn<(fileName: string, code: string) => void>();
	const result = await build({
		entryPoints: [entry],
		absWorkingDir: root,
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		logLevel: "silent",
		plugins: [lunaNativePlugin(path.join(root, pluginEntryPoint), pkgName, onNativeCode)],
	});
	return { text: result.outputFiles![0].text, onNativeCode };
};

/** A native file inside the plugin folder, as esbuild reports it (absolute, forward slashes) since the temp dir is outside the build cwd */
const nativePath = (root: string, relativePath: string) => path.join(root, relativePath).replaceAll("\\", "/");

const nativeFiles = {
	"src/mod.native.ts": 'export const addTwo = (n: number) => n + 2;\nexport const greet = (who: string) => "hi " + who;\n',
	"src/helper.ts": 'export const helperValue = "from-helper";\n',
	"src/index.ts":
		'import { addTwo, greet } from "./mod.native";\nimport { helperValue } from "./helper";\nexport { addTwo, greet, helperValue };\n',
};

describe("lunaNativePlugin", () => {
	test("builds the native module for the main process and reports its code", async () => {
		const root = await writePlugin(nativeFiles);
		const { onNativeCode } = await buildPlugin(root, "./src/index.ts", "./src/index.ts");

		expect(onNativeCode).toHaveBeenCalledOnce();
		const [fileName, code] = onNativeCode.mock.calls[0];
		// Named after the package, with its path under the plugin entry point's folder, whatever the build cwd is
		expect(fileName).toBe(`${pkgName}/mod.native.ts`);
		// Main process code: cjs bundle of the native file only, minified, exports intact
		expect(code).toContain("module.exports");
		expect(code).toContain("addTwo");
		expect(code).toContain("greet");
		expect(code.trim().split("\n")).toHaveLength(1);
		expect(code).not.toContain("from-helper");
	});

	test("the import becomes registerNative plus one async stub per export, other modules are untouched", async () => {
		const root = await writePlugin(nativeFiles);
		const { text, onNativeCode } = await buildPlugin(root, "./src/index.ts", "./src/index.ts");
		const [fileName] = onNativeCode.mock.calls[0];

		// Registered once, under the exact name onNativeCode was given
		expect(text.match(/__Luna\.registerNative/g)).toHaveLength(1);
		expect(text).toContain(`__Luna.registerNative", ${JSON.stringify(fileName)}`);

		// One stub per native export, all going through the channel the registration returned
		expect(text).toContain('__ipcRenderer.invoke(channel, "addTwo", ...args)');
		expect(text).toContain('__ipcRenderer.invoke(channel, "greet", ...args)');
		expect(text.match(/__ipcRenderer\.invoke\(channel, /g)).toHaveLength(2);

		// The non-native module is bundled as usual: no registration, no native code
		expect(text).toContain('var helperValue = "from-helper"');
	});

	test("the native module is registered under the package name", async () => {
		const root = await writePlugin(nativeFiles);
		const { onNativeCode } = await buildPlugin(root, "./src/index.ts", "src/index.ts");

		const [fileName] = onNativeCode.mock.calls[0];
		// Named after the package, with the path under the entry point's folder
		expect(fileName).toBe(`${pkgName}/mod.native.ts`);
	});

	test("a plugin entry that is itself native is registered under the package name", async () => {
		const root = await writePlugin({
			"src/index.native.ts": 'export const ping = () => "pong";\nexport const echo = (value: string) => value;\n',
		});
		const { text, onNativeCode } = await buildPlugin(root, "./src/index.native.ts", "src/index.native.ts");

		const [fileName] = onNativeCode.mock.calls[0];
		expect(fileName).toBe(pkgName);
		// That is the name it registers under
		expect(text).toContain(`__Luna.registerNative", ${JSON.stringify(fileName)}`);
		expect(text).toContain('__ipcRenderer.invoke(channel, "ping", ...args)');
		expect(text).toContain('__ipcRenderer.invoke(channel, "echo", ...args)');
	});

	test("the stubs invoke IPC and return what the main process resolves", async () => {
		const root = await writePlugin(nativeFiles);
		const { text, onNativeCode } = await buildPlugin(root, "./src/index.ts", "./src/index.ts");
		const [fileName, code] = onNativeCode.mock.calls[0];

		// Evaluated from the emitted text, with a fake main process behind __ipcRenderer
		const outfile = path.join(dir, `bundle-${builds++}.mjs`);
		await writeFile(outfile, text);
		const invocations: unknown[][] = [];
		const original = (globalThis as any).__ipcRenderer;
		(globalThis as any).__ipcRenderer = {
			...original,
			invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
				invocations.push([channel, ...args]);
				// The main process hands back the channel the native code is registered under, then serves its exports
				return channel === "__Luna.registerNative" ? "native-channel" : `${args[0]}-result`;
			}),
		};
		try {
			const module = await import(pathToFileURL(outfile).href);
			const pending = module.addTwo(2);
			expect(pending).toBeInstanceOf(Promise);
			expect(await pending).toBe("addTwo-result");
			expect(await module.greet("bob")).toBe("greet-result");
		} finally {
			(globalThis as any).__ipcRenderer = original;
		}

		// Registration first: the native code is registered under the entry name with the code onNativeCode got
		expect(invocations[0]?.[0]).toBe("__Luna.registerNative");
		expect(invocations[0]?.[1]).toBe(fileName);
		expect(invocations[0]?.[2]).toBe(code);
		// Then the stubs: channel, export name, arguments
		expect(invocations).toContainEqual(["native-channel", "addTwo", 2]);
		expect(invocations).toContainEqual(["native-channel", "greet", "bob"]);
	});

	test("onNativeCode is optional", async () => {
		const root = await writePlugin(nativeFiles);
		const result = await build({
			entryPoints: ["./src/index.ts"],
			absWorkingDir: root,
			bundle: true,
			write: false,
			format: "esm",
			platform: "node",
			logLevel: "silent",
			plugins: [lunaNativePlugin("./src/index.ts", pkgName)],
		});

		expect(result.outputFiles![0].text).toContain("__Luna.registerNative");
	});

	// Known bug (reported in the task notes, not fixed here as build source is off limits): the stub template writes
	// `export default = (...args) => ...` for a default export, which is invalid JS, so building a native module that
	// has a default export fails. This test flips to passing once that template is fixed.
	test.fails("a native module with a default export gets a default stub", async () => {
		const root = await writePlugin({
			"src/mod.native.ts": 'export default function hello() {\n\treturn "hi";\n}\nexport const other = 1;\n',
			"src/index.ts": 'import hello from "./mod.native";\nexport { hello };\n',
		});
		const { text } = await buildPlugin(root, "./src/index.ts", "src/index.ts");
		expect(text).toContain("export default");
	});
});
