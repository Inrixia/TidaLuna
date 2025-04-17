import { type BuildOptions, build as esBuild, context as esContext } from "esbuild";

import { readFile } from "fs/promises";
import path from "path";

import { fileUrlPlugin } from "./plugins/fileUrl.js";
import { lunaNativePlugin } from "./plugins/lunaNativePlugin.js";
import { writeBundlePlugin } from "./plugins/writeBundlePlugin.js";

export const defaultBuildOptions: BuildOptions = {
	sourcemap: true,
	bundle: true,
	treeShaking: true,
	minify: true,
};

export const pluginBuildOptions = async (pluginPath: string, opts?: BuildOptions) => {
	const pluginPackage = await readFile(path.join(pluginPath, "package.json"), "utf8").then(JSON.parse);
	return <BuildOptions>{
		...defaultBuildOptions,
		sourcemap: false,
		write: false,
		platform: "browser",
		format: "esm",
		outdir: "./dist",
		entryPoints: ["./" + path.join(pluginPath, pluginPackage.main ?? pluginPackage.exports ?? "index.js")],
		...opts,
		external: [...(opts?.external ?? []), "@neptune", "@plugin", "electron"],
		plugins: [...(opts?.plugins ?? []), fileUrlPlugin, lunaNativePlugin, writeBundlePlugin(pluginPackage)],
	};
};

/**
 * Overloads the given opts to use the logOutputPlugin and writeBundlePlugin
 */
const makeBuildOpts = (opts: BuildOptions) => {
	try {
		return <BuildOptions>{
			...defaultBuildOptions,
			...opts,
			write: false,
			plugins: [...(opts?.plugins ?? []), writeBundlePlugin()],
		};
	} catch (err) {
		console.error(opts, err);
		throw err;
	}
};

export const build = async (opts: BuildOptions) => {
	const _opts = await makeBuildOpts(opts);
	return esBuild(_opts).catch((err) => {
		console.error(_opts, err);
		throw err;
	});
};
export const context = (opts: BuildOptions) => {
	const _opts = makeBuildOpts(opts);
	return esContext(_opts).catch((err) => {
		console.error(_opts, err);
		throw err;
	});
};

export { type BuildOptions };
