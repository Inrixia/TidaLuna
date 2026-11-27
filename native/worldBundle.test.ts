// Run: pnpm exec vitest run native/worldBundle.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { expect, test } from "vitest";

import { inputFiles, nativeFileName } from "../build/plugins/lunaNativePlugin";
import { buildWorld, pageNativeNames } from "../build/plugins/lunaWorldPlugin";
import { isBundle, parseBundle } from "./worldBundle";

test("isBundle accepts only world code with native file code strings", () => {
	expect(isBundle({ code: "", natives: {} })).toBe(true);
	expect(isBundle({ code: "x", natives: { "a/b.native.ts": "module.exports = {}" } })).toBe(true);
	expect(isBundle(null)).toBe(false);
	expect(isBundle({ code: 1, natives: {} })).toBe(false);
	expect(isBundle({ code: "", natives: null })).toBe(false);
	expect(isBundle({ code: "", natives: ["x"] })).toBe(false);
	expect(isBundle({ code: "", natives: { a: 1 } })).toBe(false);
});

test("parseBundle throws for anything but a world bundle", () => {
	expect(parseBundle('{"code":"x","natives":{}}')).toStrictEqual({ code: "x", natives: {} });
	expect(() => parseBundle('{"code":1}')).toThrow();
	expect(() => parseBundle("not json")).toThrow();
});

test("pageNativeNames finds the registerNative calls lunaNativePlugin emits", () => {
	const code = `const c=await __ipcRenderer.invoke("__Luna.registerNative","Pkg/a.native.ts","code");await __ipcRenderer.invoke( '__Luna.registerNative' , 'Pkg/b\\'s.native.ts', "x");`;
	expect(pageNativeNames(code)).toStrictEqual(["Pkg/a.native.ts", "Pkg/b's.native.ts"]);
	expect(pageNativeNames(`__ipcRenderer.invoke("__Luna.registerNativeFrom", "u", "Pkg/a.native.ts")`)).toStrictEqual([]);
});

test("nativeFileName names a native file the same on POSIX and Windows, with a relative or absolute entry point", () => {
	const { posix, win32 } = path;
	// esbuild's entryPoint is relative to the working directory, also for a file outside it (a temp folder)
	expect(nativeFileName("../../../tmp/w/src/size.native.ts", "/tmp/w/src/index.ts", "Pkg", "/home/u/repo", posix)).toBe("Pkg/size.native.ts");
	expect(nativeFileName("plugins/x/src/a/b.native.ts", "plugins/x/src/index.ts", "Pkg", "/home/u/repo", posix)).toBe("Pkg/a/b.native.ts");
	expect(nativeFileName("plugins/x/src/index.native.ts", "plugins/x/src/index.native.ts", "Pkg", "/home/u/repo", posix)).toBe("Pkg");
	// Outside the plugin's folder: kept as it is
	expect(nativeFileName("plugins/lib.native/src/index.native.ts", "plugins/x/src/index.ts", "Pkg", "/home/u/repo", posix)).toBe(
		"plugins/lib.native/src/index.native.ts",
	);
	// A folder that only starts with the same name isn't the plugin's
	expect(nativeFileName("plugins/x/src2/a.native.ts", "plugins/x/src/index.ts", "Pkg", "/home/u/repo", posix)).toBe("plugins/x/src2/a.native.ts");
	expect(
		nativeFileName(
			"C:/Users/u/AppData/Local/Temp/w/src/size.native.ts",
			"C:\\Users\\u\\AppData\\Local\\Temp\\w\\src\\index.ts",
			"Pkg",
			"E:\\repo",
			win32,
		),
	).toBe("Pkg/size.native.ts");
	expect(nativeFileName("plugins/x/src/a.native.ts", "plugins\\x\\src\\index.ts", "Pkg", "E:\\repo", win32)).toBe("Pkg/a.native.ts");
});

test("inputFiles makes esbuild's inputs absolute on POSIX and Windows and drops virtual ones", () => {
	const inputs = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, {}]));
	expect(
		inputFiles(inputs("../../../tmp/w/src/a.native.ts", "src/b.ts", "lunaWorldRuntime:@luna/world", "file-url:x.css"), "/home/u/repo", path.posix),
	).toStrictEqual(["/tmp/w/src/a.native.ts", "/home/u/repo/src/b.ts"]);
	expect(inputFiles(inputs("C:/Temp/w/a.native.ts", "src/b.ts"), "E:\\repo", path.win32)).toStrictEqual([
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
		expect(Object.keys(world.natives)).toStrictEqual(["Pkg/size.native.ts"]);
		expect(world.natives["Pkg/size.native.ts"]).toMatch(/module\.exports/);
		expect(world.code).toMatch(/__LunaNative\.invoke\("Pkg\/size\.native\.ts", ?"grow"/);
		expect(world.code).toMatch(/__LunaNative\.invoke\("Pkg\/size\.native\.ts", ?"default"/);
		expect(world.code).toMatch(/__lunaWorldUnload/);
		expect(world.watchFiles.some((file) => file.endsWith("index.world.ts"))).toBeTruthy();
		expect(world.watchFiles.every((file) => path.isAbsolute(file))).toBeTruthy();

		// Luna's page modules don't exist in a world
		await writeFile(path.join(src, "bad.world.ts"), 'import { redux } from "@luna/lib";\nconsole.log(redux);\n');
		await expect(buildWorld(path.join(src, "bad.world.ts"), path.join(src, "index.ts"), "Pkg")).rejects.toThrow(/not available in a plugin world/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a world's lunaFetch goes over the world bridge and gives a Response", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "luna-world-"));
	try {
		await writeFile(path.join(dir, "index.ts"), "export {};\n");
		await writeFile(
			path.join(dir, "index.world.ts"),
			'import { lunaFetch } from "@luna/world";\nglobalThis.result = lunaFetch("https://api.example.com/x", { method: "POST", body: "hi" }).then(async (res) => [res.status, res.url, await res.text()]);\n',
		);
		const world = await buildWorld(path.join(dir, "index.world.ts"), path.join(dir, "index.ts"), "Pkg");
		const requests: unknown[] = [];
		const context = vm.createContext({
			Request,
			Response,
			Uint8Array,
			TextEncoder,
			Object,
			__LunaNative: {
				url: "https://store/Pkg",
				fetch: async (request: { body: Uint8Array }) => {
					requests.push({ ...request, body: new TextDecoder().decode(request.body) });
					return {
						status: 200,
						statusText: "OK",
						url: "https://api.example.com/y",
						redirected: true,
						headers: [],
						body: new TextEncoder().encode("ok"),
					};
				},
			},
		});
		vm.runInContext(world.code, context);
		expect(JSON.parse(JSON.stringify(await context.result))).toEqual([200, "https://api.example.com/y", "ok"]);
		expect(JSON.parse(JSON.stringify(requests))).toEqual([
			{ url: "https://api.example.com/x", method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: "hi" },
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
