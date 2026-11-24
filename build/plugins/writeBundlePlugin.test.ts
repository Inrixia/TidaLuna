import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, type BuildOptions } from "esbuild";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

import { writeBundlePlugin } from "./writeBundlePlugin";

/**
 * `writeBundlePlugin` writes every file esbuild produced, even for the `write: false` builds Luna and external plugin
 * repos use. Given the plugin's package.json it also writes `<bundle>.json` beside the bundle: the package contents
 * plus the content `hash` the loader compares to decide whether to refetch the plugin code.
 */

const pkg = { name: "@test/plugin", version: "1.0.0", main: "index.ts" };

let dir: string;
let log: MockInstance;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-writebundle-"));
	// The plugin logs a line per output file, which tests do not need in the output
	log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
	log.mockRestore();
	await rm(dir, { recursive: true, force: true });
});

/** Write a plugin package.json and its entry module, returning the paths a real plugin build would pass in */
const pluginFiles = async (source = 'export const marker = "first";\n') => {
	const pkgPath = path.join(dir, "package.json");
	await writeFile(pkgPath, JSON.stringify(pkg));
	const entry = path.join(dir, "index.ts");
	await writeFile(entry, source);
	const outfile = path.join(dir, "dist", "testplugin.mjs");
	return { pkgPath, entry, outfile };
};

/** A plugin build as `build/index.ts` does it: esbuild writes nothing, the plugin writes the files */
const buildBundle = (entry: string, outfile: string, pkgPath?: string, opts: BuildOptions = {}) =>
	build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		format: "esm",
		logLevel: "silent",
		write: false,
		...opts,
		plugins: [writeBundlePlugin(pkgPath)],
	});

const jsonPathOf = (outfile: string) => outfile.replace(/\.mjs$/, ".json");
const readJson = async (outfile: string) => JSON.parse(await readFile(jsonPathOf(outfile), "utf8"));
/** The `[hash]` of every output file the plugin logged */
const loggedHashes = () => log.mock.calls.flatMap(([message]) => /^Built \[([^\]]+)\]/.exec(String(message))?.[1] ?? []);

describe("writeBundlePlugin", () => {
	test("writes the bundle and a json beside it with the package contents and the bundle hash", async () => {
		const { pkgPath, entry, outfile } = await pluginFiles();
		await buildBundle(entry, outfile, pkgPath);

		expect(existsSync(outfile)).toBe(true);
		expect(await readFile(outfile, "utf8")).toContain('"first"');

		// The loader reads this next to the plugin bundle: the plugin's package.json plus the hash of the code
		const written = await readJson(outfile);
		expect(written).toEqual({ ...pkg, hash: expect.any(String) });
		expect(written.hash.length).toBeGreaterThan(0);
		expect(await readdir(path.dirname(outfile))).toEqual(expect.arrayContaining(["testplugin.json", "testplugin.mjs"]));

		// And it is the hash esbuild reported for the bundle, not some other value
		expect(loggedHashes()).toEqual([written.hash]);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("testplugin.mjs"));
	});

	test("the hash follows the bundled contents", async () => {
		const { pkgPath, entry, outfile } = await pluginFiles();
		await buildBundle(entry, outfile, pkgPath);
		const first = await readJson(outfile);

		// Unchanged source: unchanged bundle, so an installed plugin is not refetched
		await buildBundle(entry, outfile, pkgPath);
		expect((await readJson(outfile)).hash).toBe(first.hash);

		// Changed source: new hash, which is what makes the loader refetch
		await writeFile(entry, 'export const marker = "second";\n');
		await buildBundle(entry, outfile, pkgPath);
		const changed = await readJson(outfile);
		expect(changed.hash).not.toBe(first.hash);
		expect(await readFile(outfile, "utf8")).toContain('"second"');
	});

	test("without a package.json path only the bundle is written", async () => {
		const { entry, outfile } = await pluginFiles();
		await buildBundle(entry, outfile);

		expect(existsSync(outfile)).toBe(true);
		expect(existsSync(jsonPathOf(outfile))).toBe(false);
	});

	test("only .mjs outputs get a json beside them", async () => {
		const { pkgPath, entry } = await pluginFiles();
		const outfile = path.join(dir, "dist", "testplugin.js");
		await buildBundle(entry, outfile, pkgPath);

		expect(existsSync(outfile)).toBe(true);
		expect(existsSync(outfile.replace(/\.js$/, ".json"))).toBe(false);
	});

	test("every output file is written, and one json describes the bundle", async () => {
		const { pkgPath, entry, outfile } = await pluginFiles();
		await buildBundle(entry, outfile, pkgPath, { sourcemap: true });

		expect(existsSync(outfile)).toBe(true);
		expect(existsSync(`${outfile}.map`)).toBe(true);
		const written = await readJson(outfile);
		// The json carries the bundle's hash, which is one of the hashes logged for the outputs
		expect(loggedHashes()).toContain(written.hash);
	});

	test("a failed build writes nothing", async () => {
		const { pkgPath, entry, outfile } = await pluginFiles("export const = broken;\n");

		await expect(buildBundle(entry, outfile, pkgPath)).rejects.toThrow(/Build failed/);
		// The plugin bails on errors before writing anything, so not even the output directory is created
		expect(existsSync(path.dirname(outfile))).toBe(false);
		expect(loggedHashes()).toEqual([]);
	});
});
