// Run: pnpm exec tsx --test native/worldBundle.test.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { inputFiles, nativeFileName } from "../build/plugins/lunaNativePlugin";
import { buildWorld, pageNativeNames } from "../build/plugins/lunaWorldPlugin";
import { isBundle, parseBundle } from "./worldBundle";

test("isBundle accepts only world code with native file code strings", () => {
	assert.equal(isBundle({ code: "", natives: {} }), true);
	assert.equal(isBundle({ code: "x", natives: { "a/b.native.ts": "module.exports = {}" } }), true);
	assert.equal(isBundle(null), false);
	assert.equal(isBundle({ code: 1, natives: {} }), false);
	assert.equal(isBundle({ code: "", natives: null }), false);
	assert.equal(isBundle({ code: "", natives: ["x"] }), false);
	assert.equal(isBundle({ code: "", natives: { a: 1 } }), false);
});

test("parseBundle throws for anything but a world bundle", () => {
	assert.deepEqual(parseBundle('{"code":"x","natives":{}}'), { code: "x", natives: {} });
	assert.throws(() => parseBundle('{"code":1}'));
	assert.throws(() => parseBundle("not json"));
});

test("pageNativeNames finds the registerNative calls lunaNativePlugin emits", () => {
	const code = `const c=await __ipcRenderer.invoke("__Luna.registerNative","Pkg/a.native.ts","code");await __ipcRenderer.invoke( '__Luna.registerNative' , 'Pkg/b\\'s.native.ts', "x");`;
	assert.deepEqual(pageNativeNames(code), ["Pkg/a.native.ts", "Pkg/b's.native.ts"]);
	assert.deepEqual(pageNativeNames(`__ipcRenderer.invoke("__Luna.registerNativeFrom", "u", "Pkg/a.native.ts")`), []);
});

test("nativeFileName names a native file the same on POSIX and Windows, with a relative or absolute entry point", () => {
	const { posix, win32 } = path;
	// esbuild's entryPoint is relative to the working directory, also for a file outside it (a temp folder)
	assert.equal(nativeFileName("../../../tmp/w/src/size.native.ts", "/tmp/w/src/index.ts", "Pkg", "/home/u/repo", posix), "Pkg/size.native.ts");
	assert.equal(nativeFileName("plugins/x/src/a/b.native.ts", "plugins/x/src/index.ts", "Pkg", "/home/u/repo", posix), "Pkg/a/b.native.ts");
	assert.equal(nativeFileName("plugins/x/src/index.native.ts", "plugins/x/src/index.native.ts", "Pkg", "/home/u/repo", posix), "Pkg");
	// Outside the plugin's folder: kept as it is
	assert.equal(
		nativeFileName("plugins/lib.native/src/index.native.ts", "plugins/x/src/index.ts", "Pkg", "/home/u/repo", posix),
		"plugins/lib.native/src/index.native.ts",
	);
	// A folder that only starts with the same name isn't the plugin's
	assert.equal(
		nativeFileName("plugins/x/src2/a.native.ts", "plugins/x/src/index.ts", "Pkg", "/home/u/repo", posix),
		"plugins/x/src2/a.native.ts",
	);
	assert.equal(
		nativeFileName(
			"C:/Users/u/AppData/Local/Temp/w/src/size.native.ts",
			"C:\\Users\\u\\AppData\\Local\\Temp\\w\\src\\index.ts",
			"Pkg",
			"E:\\repo",
			win32,
		),
		"Pkg/size.native.ts",
	);
	assert.equal(nativeFileName("plugins/x/src/a.native.ts", "plugins\\x\\src\\index.ts", "Pkg", "E:\\repo", win32), "Pkg/a.native.ts");
});

test("inputFiles makes esbuild's inputs absolute on POSIX and Windows and drops virtual ones", () => {
	const inputs = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, {}]));
	assert.deepEqual(
		inputFiles(inputs("../../../tmp/w/src/a.native.ts", "src/b.ts", "lunaWorldRuntime:@luna/world", "file-url:x.css"), "/home/u/repo", path.posix),
		["/tmp/w/src/a.native.ts", "/home/u/repo/src/b.ts"],
	);
	assert.deepEqual(inputFiles(inputs("C:/Temp/w/a.native.ts", "src/b.ts"), "E:\\repo", path.win32), [
		"C:\\Temp\\w\\a.native.ts",
		"E:\\repo\\src\\b.ts",
	]);
});

test("buildWorld turns native imports into calls over the world bridge", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "luna-world-"));
	try {
		const src = path.join(dir, "src");
		await mkdir(src);
		await writeFile(path.join(src, "index.ts"), "export {};\n");
		await writeFile(path.join(src, "size.native.ts"), "export const grow = (n: number) => n + 1;\nexport default () => 0;\n");
		await writeFile(
			path.join(src, "index.world.ts"),
			'import { onUnload, url } from "@luna/world";\nimport shrink, { grow } from "./size.native";\ngrow(1);\nonUnload(() => shrink());\nconsole.log(url);\n',
		);
		const world = await buildWorld(path.join(src, "index.world.ts"), path.join(src, "index.ts"), "Pkg");
		assert.deepEqual(Object.keys(world.natives), ["Pkg/size.native.ts"]);
		assert.match(world.natives["Pkg/size.native.ts"], /module\.exports/);
		assert.match(world.code, /__LunaNative\.invoke\("Pkg\/size\.native\.ts", ?"grow"/);
		assert.match(world.code, /__LunaNative\.invoke\("Pkg\/size\.native\.ts", ?"default"/);
		assert.match(world.code, /__lunaWorldUnload/);
		assert.ok(world.watchFiles.some((file) => file.endsWith("index.world.ts")));
		assert.ok(world.watchFiles.every((file) => path.isAbsolute(file)));

		// Luna's page modules don't exist in a world
		await writeFile(path.join(src, "bad.world.ts"), 'import { redux } from "@luna/lib";\nconsole.log(redux);\n');
		await assert.rejects(buildWorld(path.join(src, "bad.world.ts"), path.join(src, "index.ts"), "Pkg"), /not available in a plugin world/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
