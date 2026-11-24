import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build as esBuild } from "esbuild";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

import { build, defaultBuildOptions, listen, makeBuildOpts, pluginBuildOptions, TidalChromeVersion, watch } from "./index";
import { fileUrlPlugin } from "./plugins/fileUrl";
import { writeBundlePlugin } from "./plugins/writeBundlePlugin";

/**
 * `build/index.ts` is what external plugin repos import as `luna/build`. `pluginBuildOptions` turns a plugin package
 * into the options esbuild builds it with, `makeBuildOpts` wraps arbitrary builds so their output goes through
 * `writeBundlePlugin`, and `listen` picks build or watch from the command line.
 *
 * Fixtures are fake plugin packages in a temp dir and every esbuild run writes there: the default outfile is
 * `./dist/<name>.mjs`, which would otherwise land in the repo. `build/buildPlugins.ts` is never imported because it
 * calls `listen()` at import time.
 */

let dir: string;
let log: MockInstance;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-build-"));
	// The plugins log a line per output file, which tests do not need in the output
	log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
	log.mockRestore();
	await rm(dir, { recursive: true, force: true });
});

/** A fake plugin package: its package.json, plus an entry module written beside it */
const pluginPackage = async (pkg: Record<string, unknown>, source = 'export const marker = "PLUGIN_MARKER";\n') => {
	const pluginDir = await mkdtemp(path.join(dir, "pkg-"));
	await writeFile(path.join(pluginDir, "package.json"), JSON.stringify(pkg));
	await writeFile(path.join(pluginDir, "index.ts"), source);
	return pluginDir;
};

/** `build()` does not return the esbuild promise, so wait for `writeBundlePlugin` to write the bundle */
const waitForFile = async (file: string, timeoutMs = 10_000) => {
	const started = Date.now();
	while (!existsSync(file)) {
		if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

/** The names of the plugins in an options object, in the order esbuild will run them */
const pluginNames = (opts: { plugins?: { name: string }[] }) => opts.plugins?.map((plugin) => plugin.name);

/**
 * Run `fn` from inside the temp dir. `pluginBuildOptions` resolves the plugin path against the working directory (`buildPlugins.ts`
 * passes `./plugins/<name>`) and prefixes the entry point with "./", so a plugin path has to be relative to it.
 * esbuild needs `absWorkingDir` set as well: in a test process its default working directory does not follow `process.chdir`.
 */
const inTempCwd = async <T>(fn: () => Promise<T>): Promise<T> => {
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		return await fn();
	} finally {
		process.chdir(cwd);
	}
};

/** Bundle a fake plugin package through `pluginBuildOptions` and return the code esbuild produced */
const bundlePlugin = async (pluginDir: string, opts = {}) =>
	inTempCwd(async () => {
		const options = await pluginBuildOptions(path.relative(dir, pluginDir), opts);
		const { outputFiles } = await esBuild({ ...options, absWorkingDir: dir, logLevel: "silent" });
		// sourcemap is on by default, so the bundle is not necessarily the first output file
		return outputFiles!.find((file) => file.path.endsWith(".mjs"))!.text;
	});

/** Import a fresh module instance so `listen` sees the `process.argv` it was given */
const importFresh = async (argv: string[]) => {
	const originalArgv = process.argv;
	process.argv = [...argv];
	vi.resetModules();
	try {
		return await import("./index");
	} finally {
		process.argv = originalArgv;
	}
};

describe("pluginBuildOptions", () => {
	test("derives the output name from the package name and reads the entry point from main", async () => {
		const pluginDir = await pluginPackage({ name: "@luna/plugin-test", main: "index.ts" });
		const opts = await pluginBuildOptions(pluginDir);

		// @ and / are stripped so the bundle name is a safe file name
		expect(opts.outfile).toBe("./dist/luna.plugin-test.mjs");
		expect(opts.entryPoints).toEqual(["./" + path.join(pluginDir, "index.ts")]);
	});

	test("an unscoped package name is used as is", async () => {
		const pluginDir = await pluginPackage({ name: "tidal-plugin", main: "index.ts" });
		expect((await pluginBuildOptions(pluginDir)).outfile).toBe("./dist/tidal-plugin.mjs");
	});

	test("resolves the entry point from main, exports, or index.mjs", async () => {
		const name = { name: "@luna/plugin-test" };
		const cases: [Record<string, unknown>, string][] = [
			[{ ...name, main: "src/main.ts" }, "src/main.ts"],
			// main wins over exports
			[{ ...name, main: "src/main.ts", exports: "./src/exports.ts" }, "src/main.ts"],
			[{ ...name, exports: "./src/exports.ts" }, "./src/exports.ts"],
			[{ ...name, exports: { ".": "./src/dot.ts" } }, "./src/dot.ts"],
			[{ ...name, exports: { ".": { default: "./src/dotDefault.ts" } } }, "./src/dotDefault.ts"],
			// nothing declared: fall back to index.mjs, which the package may ship prebuilt
			[name, "index.mjs"],
		];
		for (const [pkg, entry] of cases) {
			const pluginDir = await pluginPackage(pkg);
			const opts = await pluginBuildOptions(pluginDir);
			expect(opts.entryPoints, JSON.stringify(pkg)).toEqual(["./" + path.join(pluginDir, entry)]);
		}
	});

	test("builds a browser ESM bundle for TIDAL's chrome target, in memory", async () => {
		const pluginDir = await pluginPackage({ name: "@luna/plugin-test", main: "index.ts" });
		const opts = await pluginBuildOptions(pluginDir);

		expect(opts).toMatchObject({
			...defaultBuildOptions,
			write: false,
			platform: "browser",
			target: TidalChromeVersion,
			format: "esm",
		});
		// No extra opts: just the plugins every Luna plugin build needs
		expect(pluginNames(opts)).toEqual(["dynamicExternals", "fileUrl", "lunaNativePlugin", "writeBundlePlugin"]);
	});

	test("marks TIDAL's modules external, after any the caller adds", async () => {
		const pluginDir = await pluginPackage({ name: "@luna/plugin-test", main: "index.ts" });
		const opts = await pluginBuildOptions(pluginDir, { external: ["some-native-module"] });

		expect(opts.external).toEqual(["some-native-module", "@luna/*", "oby", "react", "react-dom/client", "react/jsx-runtime", "electron"]);
	});

	test("caller opts are applied and their plugins come first, the Luna plugins are always added", async () => {
		const pluginDir = await pluginPackage({ name: "@luna/plugin-test", main: "index.ts" });
		const opts = await pluginBuildOptions(pluginDir, { platform: "node", minify: false, plugins: [fileUrlPlugin] });

		expect(opts).toMatchObject({ platform: "node", minify: false, bundle: true, format: "esm", target: TidalChromeVersion });
		// A caller plugin comes first, the Luna plugins still come after it
		expect(pluginNames(opts)).toEqual(["fileUrl", "dynamicExternals", "fileUrl", "lunaNativePlugin", "writeBundlePlugin"]);
	});

	test("opts are spread last, so a caller can turn the write back on", async () => {
		// Pinning real behaviour: `write: false` is only a default here (unlike `makeBuildOpts`, which forces it),
		// because the caller's opts are spread after it.
		const pluginDir = await pluginPackage({ name: "@luna/plugin-test", main: "index.ts" });
		expect((await pluginBuildOptions(pluginDir, { write: true })).write).toBe(true);
		expect((await pluginBuildOptions(pluginDir)).write).toBe(false);
	});

	test("bundles the plugin, resolving TIDAL's modules through luna.core.modules", async () => {
		const pluginDir = await pluginPackage(
			{ name: "@luna/plugin-test", main: "index.ts" },
			'import "react";\nimport "@luna/lib";\nexport const marker = "PLUGIN_MARKER";\n',
		);
		// Not minified so the generated module lookup is readable
		const code = await bundlePlugin(pluginDir, { minify: false });

		expect(code).toContain("PLUGIN_MARKER");
		// External in the options, but resolved to Luna's module registry rather than left as an import
		expect(code).toContain('luna?.core?.modules?.["react"]');
		expect(code).toContain('luna?.core?.modules?.["@luna/lib"]');
		expect(code).not.toMatch(/from "(react|@luna\/lib)"/);
	});

	test("the bundle is written with a hash beside the plugin's package.json", async () => {
		const pluginDir = await pluginPackage({ name: "@luna/plugin-test", main: "index.ts" });

		await inTempCwd(async () => {
			// No outfile override: the default is ./dist/<safe name>.mjs, resolved against absWorkingDir
			const options = await pluginBuildOptions(path.relative(dir, pluginDir));
			await esBuild({ ...options, absWorkingDir: dir, logLevel: "silent" });
		});

		// writeBundlePlugin writes the package.json copy plus the hash the loader compares on refetch
		const written = JSON.parse(await readFile(path.join(dir, "dist", "luna.plugin-test.json"), "utf8"));
		expect(written).toEqual({ name: "@luna/plugin-test", main: "index.ts", hash: expect.any(String) });
		expect(await readFile(path.join(dir, "dist", "luna.plugin-test.mjs"), "utf8")).toContain("PLUGIN_MARKER");
	});
});

describe("makeBuildOpts", () => {
	test("keeps builds in memory and adds writeBundlePlugin", () => {
		const opts = makeBuildOpts({ entryPoints: ["a.ts"], outfile: "out/a.mjs" });

		expect(opts).toMatchObject({ ...defaultBuildOptions, entryPoints: ["a.ts"], outfile: "out/a.mjs", write: false });
		expect(pluginNames(opts)).toEqual(["writeBundlePlugin"]);
	});

	test("caller opts override the defaults", () => {
		const opts = makeBuildOpts({ minify: false, sourcemap: false });
		expect(opts).toMatchObject({ ...defaultBuildOptions, minify: false, sourcemap: false });
	});

	test("a caller asking for a write is overridden, the plugins write the output instead", () => {
		expect(makeBuildOpts({ write: true }).write).toBe(false);
	});

	test("does not add a second writeBundlePlugin", () => {
		const existing = writeBundlePlugin(path.join(dir, "package.json"));
		const opts = makeBuildOpts({ plugins: [fileUrlPlugin, existing] });

		expect(pluginNames(opts)).toEqual(["fileUrl", "writeBundlePlugin"]);
		// The caller's instance is kept, not replaced by a new one
		expect(opts.plugins?.[1]).toBe(existing);
	});

	test("other plugins are kept, writeBundlePlugin is appended last", () => {
		const opts = makeBuildOpts({ plugins: [fileUrlPlugin] });
		expect(pluginNames(opts)).toEqual(["fileUrl", "writeBundlePlugin"]);
	});

	test("a plugin build's options are left alone, they already write through writeBundlePlugin", async () => {
		const pluginDir = await pluginPackage({ name: "@luna/plugin-test", main: "index.ts" });
		const pluginOpts = await pluginBuildOptions(pluginDir);
		const opts = makeBuildOpts(pluginOpts);

		expect(pluginNames(opts)).toEqual(pluginNames(pluginOpts));
		expect(opts.outfile).toBe("./dist/luna.plugin-test.mjs");
	});
});

describe("build", () => {
	test("builds every given options object and writes it through writeBundlePlugin", async () => {
		const builds = await Promise.all(
			["first", "second"].map(async (name) => {
				const entry = path.join(dir, `${name}-entry.ts`);
				await writeFile(entry, `export const built = "${name.toUpperCase()}_MARKER";\n`);
				return { name, entry, outfile: path.join(dir, name, "bundle.mjs") };
			}),
		);

		// build() fires esbuild off without returning the promises
		expect(build(builds.map(({ entry, outfile }) => ({ entryPoints: [entry], outfile, logLevel: "silent" })))).toBeUndefined();

		await Promise.all(builds.map(({ outfile }) => waitForFile(outfile)));
		expect(await readFile(builds[0].outfile, "utf8")).toContain("FIRST_MARKER");
		expect(await readFile(builds[1].outfile, "utf8")).toContain("SECOND_MARKER");
		expect(log).toHaveBeenCalledWith(expect.stringContaining("bundle.mjs"));
	});
});

describe("listen", () => {
	test("is build when the command line has no --watch", async () => {
		const fresh = await importFresh([process.execPath, "build-plugins"]);
		expect(fresh.listen).toBe(fresh.build);
	});

	test("is watch when the command line has --watch", async () => {
		const fresh = await importFresh([process.execPath, "build-plugins", "--watch"]);
		expect(fresh.listen).toBe(fresh.watch);
		expect(fresh.watch).not.toBe(fresh.build);
	});

	test("the export is the choice made when the module was first imported", () => {
		// A dev running this file in watch mode changes the argv the module sees, so don't assume --watch is absent
		expect(listen).toBe(process.argv.includes("--watch") ? watch : build);
	});
});
