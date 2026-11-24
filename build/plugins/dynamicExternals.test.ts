import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { dynamicExternalsPlugin } from "./dynamicExternals";

/**
 * `dynamicExternalsPlugin` replaces imports of the listed modules with `moduleContents(module)`, so a plugin build can
 * pull `@luna/lib`, react and friends out of `luna.core.modules` at runtime instead of bundling them.
 *
 * The external list becomes one anchored regex (`^(?:...)$`) so a bare `react` must not swallow `react-dom/client`,
 * and the entries are regex-escaped so `@luna/lib.native` matches only itself. `moduleContents` is a spy here, which
 * is how these assert which imports the plugin handled; the bundles are evaluated where the output has to be real.
 */

let dir: string;
let builds = 0;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-dynexternals-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Resolves a module to its own path as a string, and records what it was asked to resolve */
const spyModuleContents = () => vi.fn((module: string) => `export const mod = ${JSON.stringify(module)};`);

/** Write `source` as a fresh entry module and return its path */
const writeEntry = async (source: string) => {
	const entry = path.join(dir, `entry-${builds++}.ts`);
	await writeFile(entry, source);
	return entry;
};

/**
 * Bundle `source` with the plugin.
 * `opts.external` is esbuild's own external list, used to keep imports the plugin must not handle resolvable.
 */
const bundle = async (source: string, pluginExternals?: string[], opts: { external?: string[] } = {}) => {
	const name = `entry-${builds++}`;
	const entry = await writeEntry(source);
	const moduleContents = spyModuleContents();
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		logLevel: "silent",
		external: opts.external,
		plugins: [dynamicExternalsPlugin({ moduleContents, externals: pluginExternals })],
	});
	const text = result.outputFiles![0].text;
	/** Evaluate the bundle's default export */
	const evaluate = async () => {
		const outfile = path.join(dir, `${name}.mjs`);
		await writeFile(outfile, text);
		return (await import(pathToFileURL(outfile).href)).default;
	};
	const resolved = () => moduleContents.mock.calls.map(([module]) => module).sort();
	return { text, moduleContents, resolved, evaluate };
};

describe("dynamicExternalsPlugin", () => {
	test("@luna/* and react are replaced with the module contents", async () => {
		const { text, resolved, evaluate } = await bundle(
			'import { mod as lib } from "@luna/lib";\nimport { mod as react } from "react";\nexport default [lib, react];',
			["@luna/*", "oby", "react"],
		);

		expect(resolved()).toEqual(["@luna/lib", "react"]);
		expect(await evaluate()).toEqual(["@luna/lib", "react"]);
		// Both imports are gone, replaced by the inline contents
		expect(text).not.toContain('from "@luna/lib"');
		expect(text).not.toContain('from "react"');
	});

	test("a bare react does not match react-dom/client: the filter is anchored", async () => {
		const { text, moduleContents } = await bundle('import client from "react-dom/client";\nexport default client;', ["@luna/*", "oby", "react"], {
			external: ["react-dom/client"],
		});

		expect(moduleContents).not.toHaveBeenCalled();
		// Left for esbuild, which keeps it an external import
		expect(text).toContain('from "react-dom/client"');
	});

	test("regex metacharacters in externals are escaped", async () => {
		const { text, resolved } = await bundle(
			'import { mod as dotted } from "@luna/x.y";\nimport { mod as literal } from "@luna/xzy";\nexport default [dotted, literal];',
			["@luna/x.y"],
			{ external: ["@luna/xzy"] },
		);

		// "." is a literal dot: only @luna/x.y is handled, @luna/xzy is left alone
		expect(resolved()).toEqual(["@luna/x.y"]);
		expect(text).toContain('var mod = "@luna/x.y"');
		expect(text).toContain('from "@luna/xzy"');
	});

	test("the plugin wins over esbuild's own external option", async () => {
		const { text, moduleContents, evaluate } = await bundle('import { mod } from "oby";\nexport default mod;', ["oby"], { external: ["oby"] });

		expect(moduleContents).toHaveBeenCalledWith("oby");
		expect(await evaluate()).toBe("oby");
		// Inlined, so esbuild's external list did not keep the import
		expect(text).not.toContain('from "oby"');
	});

	test("externals fall back to the build's external option", async () => {
		const { moduleContents, evaluate } = await bundle('import { mod } from "oby";\nexport default mod;', undefined, { external: ["oby"] });

		expect(moduleContents).toHaveBeenCalledWith("oby");
		expect(await evaluate()).toBe("oby");
	});

	test.each([
		["no", undefined],
		["an empty list of", []],
	] as [string, string[] | undefined][])("with %s externals the plugin intercepts nothing", async (_label, pluginExternals) => {
		const moduleContents = spyModuleContents();
		const entry = await writeEntry('import { mod } from "oby";\nexport default mod;');

		// Nothing handles the import, so esbuild's own resolution runs and fails: it is not a no-op that breaks the build
		await expect(
			build({
				entryPoints: [entry],
				bundle: true,
				write: false,
				format: "esm",
				platform: "node",
				logLevel: "silent",
				plugins: [dynamicExternalsPlugin({ moduleContents, externals: pluginExternals })],
			}),
		).rejects.toThrow(/Could not resolve "oby"/);
		expect(moduleContents).not.toHaveBeenCalled();
	});
});
