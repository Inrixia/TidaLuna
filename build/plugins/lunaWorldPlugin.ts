import { build as esBuild, type BuildResult, type Plugin } from "esbuild";

import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

import { defaultBuildOptions, TidalChromeVersion } from "../index";
import { buildNativeFile } from "./lunaNativePlugin";

/**
 * What a plugin's world (`"lunaWorld"` entry in its package.json) is built to: `<plugin>.world.json`, which the main
 * process fetches itself (see native/worlds.ts). The page never hands this code to Luna.
 */
export type LunaWorldBundle = {
	/** The world script, run in the plugin's own isolated world */
	code: string;
	/** Its native files: name -> code for the main process */
	natives: Record<string, string>;
};

// The runtime a world imports as "@luna/world". __LunaNative is the bridge preload exposes into this world only
const worldRuntime = `
const unloads = new Set();
globalThis.__lunaWorldUnload = async () => {
	for (const unload of [...unloads].reverse()) {
		try { await unload(); } catch (err) { console.error("[Luna.world]", __LunaNative.url, err); }
	}
	unloads.clear();
};
/** Runs when the plugin is disabled, reloaded or uninstalled */
export const onUnload = (unload) => void unloads.add(unload);
/** This plugin's url */
export const url = __LunaNative.url;
`;

/** Builds the code in a plugin's world: its natives become calls over the world's own bridge */
export const buildWorld = async (
	worldEntry: string,
	pluginEntryPoint: string,
	pkgName: string,
): Promise<LunaWorldBundle & { watchFiles: string[] }> => {
	const natives: Record<string, string> = {};
	const watchFiles: string[] = [];
	const { outputFiles, metafile } = await esBuild({
		...defaultBuildOptions,
		entryPoints: [worldEntry],
		write: false,
		metafile: true,
		sourcemap: false,
		platform: "browser",
		target: TidalChromeVersion,
		format: "iife",
		plugins: [
			{
				name: "lunaWorld",
				setup(build) {
					build.onResolve({ filter: /^@luna\/world$/ }, () => ({ path: "@luna/world", namespace: "lunaWorldRuntime" }));
					build.onLoad({ filter: /.*/, namespace: "lunaWorldRuntime" }, () => ({ contents: worldRuntime, loader: "js" }));
					// Luna's modules and TIDAL's redux live in the page, a world can't reach them
					build.onResolve({ filter: /^@luna\// }, (args) =>
						args.path === "@luna/world" ? undefined : { errors: [{ text: `${args.path} is not available in a plugin world, only @luna/world` }] },
					);
					build.onLoad({ filter: /.*\.native\.[a-z]+/ }, async (args) => {
						const native = await buildNativeFile(args.path, pluginEntryPoint, pkgName);
						if (native.fileName === undefined) return { errors: [{ text: `Can't name native file ${args.path}` }] };
						natives[native.fileName] = native.code;
						watchFiles.push(...native.watchFiles);
						return {
							contents: native.exportNames
								.map(
									(name) =>
										`export ${name === "default" ? "default" : `const ${name} =`} (...args) => __LunaNative.invoke(${JSON.stringify(native.fileName)}, ${JSON.stringify(name)}, ...args);`,
								)
								.join("\n"),
							loader: "js",
						};
					});
				},
			},
		],
	});
	// The world's own files (metafile inputs are relative to the working directory) and its natives' files
	// (not virtual ones like "lunaWorldRuntime:@luna/world")
	watchFiles.push(
		...Object.keys(metafile!.inputs)
			.filter((input) => !/^\w+:(?![\\/])/.test(input))
			.map((input) => path.resolve(input)),
	);
	return { code: outputFiles![0].text, natives, watchFiles };
};

/** Native files the page bundle registers itself (the call lunaNativePlugin emits) */
export const pageNativeNames = (code: string): string[] =>
	[...code.matchAll(/__ipcRenderer\.invoke\(\s*(["'`])__Luna\.registerNative\1\s*,\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/g)].map((match) =>
		match[3].replace(/\\(.)/g, "$1"),
	);

/**
 * Writes `<plugin>.world.json` next to the plugin bundle when its package.json names a `"lunaWorld"` entry. Goes before
 * writeBundlePlugin, which adds `manifestFields()` (the world's hash) to the manifest it writes, so a dev poll never sees
 * a manifest without it.
 *
 * @param isCore One of Luna's own plugins: those load no world (their urls are served from Luna's bundle)
 */
export const lunaWorldPlugin = (pluginPackagePath: string, pluginEntryPoint: string, pkgName: string, isCore = false) => {
	/** The last build's manifest fields, or why the world failed to build */
	let fields: { worldHash?: string } = {};
	let failed: unknown;
	const manifestFields = () => {
		if (failed !== undefined) throw failed;
		return fields;
	};
	const plugin: Plugin = {
		name: "lunaWorldPlugin",
		async setup(build) {
			const worldEntryOf = async () => {
				const pluginPackage = await readFile(pluginPackagePath, "utf8").then(JSON.parse);
				if (typeof pluginPackage.lunaWorld !== "string") return undefined;
				if (isCore) throw new Error(`${pkgName}: Luna's own plugins can't have a "lunaWorld", their urls load no world`);
				return path.resolve(path.dirname(pluginPackagePath), pluginPackage.lunaWorld);
			};
			// Watch mode rebuilds when an input of the plugin bundle changes: the world's files count as inputs of its entry
			const initialWorldEntry = await worldEntryOf();
			let worldWatchFiles: string[] = initialWorldEntry !== undefined ? [initialWorldEntry] : [];
			const entryPath = path.resolve(pluginEntryPoint);
			build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
				if (worldWatchFiles.length === 0 || path.resolve(args.path) !== entryPath) return undefined;
				const ext = path.extname(args.path).slice(1).replace(/^[cm]/, "") as "js" | "ts" | "jsx" | "tsx";
				return { contents: await readFile(args.path, "utf8"), loader: ext, watchFiles: worldWatchFiles };
			});

			build.onEnd(async (result) => {
				fields = {};
				failed = undefined;
				if (result.errors.length > 0) return;
				try {
					await writeWorld(result);
				} catch (err) {
					failed = err;
					throw err;
				}
			});
			const writeWorld = async (result: BuildResult) => {
				const worldEntry = await worldEntryOf();
				worldWatchFiles = worldEntry !== undefined ? [worldEntry] : [];
				if (worldEntry === undefined) return;
				const outfile = build.initialOptions.outfile;
				if (outfile === undefined) throw new Error("lunaWorldPlugin needs outfile");
				const { code, natives, watchFiles } = await buildWorld(worldEntry, pluginEntryPoint, pkgName);
				worldWatchFiles = [worldEntry, ...watchFiles];

				// A native the page bundle registers too would be refused there once the world has loaded it (native/NativeModule/worldNatives.ts)
				const pageCode = result.outputFiles?.find((file) => file.path.endsWith(".mjs"))?.text ?? "";
				const shared = pageNativeNames(pageCode).filter((name) => name in natives);
				if (shared.length > 0)
					throw new Error(`${pkgName}: ${shared.join(", ")} is imported by both the plugin and its world, import native files only from the world`);
				const bundle: LunaWorldBundle = { code, natives };
				const worldFile = outfile.replace(/\.mjs$/, ".world.json");
				const worldJson = JSON.stringify(bundle);
				await mkdir(path.dirname(worldFile), { recursive: true });
				await writeFile(worldFile, worldJson);
				// writeBundlePlugin (after this one: onEnd runs in plugin order) puts the world's hash in the manifest, so a
				// change to the world alone is a new version (see native/core/registry.ts)
				fields = { worldHash: createHash("sha256").update(worldJson, "utf8").digest("hex") };
				console.log(`Built world ${path.basename(worldFile)} (${Object.keys(natives).length} native files)`);
			};
		},
	};
	return { plugin, manifestFields };
};
