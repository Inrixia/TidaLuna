import { type BuildOptions, build as esBuild, context as esContext } from "esbuild";

import { readFile } from "fs/promises";
import path from "path";

import { dynamicExternalsPlugin } from "./plugins/dynamicExternals";
import { fileUrlPlugin } from "./plugins/fileUrl";
import { lunaNativePlugin } from "./plugins/lunaNativePlugin";
import { writeBundlePlugin } from "./plugins/writeBundlePlugin";

export const defaultBuildOptions: BuildOptions = {
	sourcemap: true,
	bundle: true,
	treeShaking: true,
	minify: true,
};

export const TidalNodeVersion = "node20.15"; // Tidal node version
export const TidalChromeVersion = "chrome126"; // Tidal target version

const externals = ["@luna/*", "oby", "react", "react-dom/client", "react/jsx-runtime", "electron"];

export const pluginBuildOptions = async (pluginPath: string, opts?: BuildOptions) => {
	const pkgPath = path.join(pluginPath, "package.json");
	const pluginPackage = await readFile(pkgPath, "utf8").then(JSON.parse);
	// Sanitize pluginPackage.name, remove @, replace / with .
	const pkgName = pluginPackage.name;
	const safeName = pkgName.replace(/@/g, "").replace(/\//g, ".");
	// Handle exports being either a string or an object with "." or "default" entry
	const exportsValue =
		typeof pluginPackage.exports === "string" ? pluginPackage.exports : (pluginPackage.exports?.["."]?.default ?? pluginPackage.exports?.["."]);
	const entryPoint = path.join(pluginPath, pluginPackage.main ?? exportsValue ?? "index.mjs");
	return <BuildOptions>{
		...defaultBuildOptions,
		write: false,
		platform: "browser",
		target: TidalChromeVersion,
		format: "esm",
		outfile: `./dist/${safeName}.mjs`,
		entryPoints: ["./" + entryPoint],
		...opts,
		external: [...(opts?.external ?? []), ...externals],
		plugins: [
			...(opts?.plugins ?? []),
			dynamicExternalsPlugin({
				moduleContents: (module: string) => `
					module.exports = luna?.core?.modules?.["${module}"];
					if (module.exports === undefined) throw new Error("Cannot find module ${module} in luna.core.modules");
					// Icky but it works
					luna.core.LunaPlugin.getByName("${module}")?.addDependant(luna.core.LunaPlugin.getByName("${pkgName}"));
				`,
			}),
			fileUrlPlugin,
			lunaNativePlugin(entryPoint, pkgName),
			writeBundlePlugin(pkgPath),
		],
	};
};

/**
 * Overloads the given opts to use the logOutputPlugin and writeBundlePlugin
 */
export const makeBuildOpts = (opts: BuildOptions) => {
	try {
		const plugins = opts?.plugins ?? [];
		const hasWriteBundle = plugins.some((p) => p?.name === writeBundlePlugin().name);
		return <BuildOptions>{
			...defaultBuildOptions,
			...opts,
			write: false,
			plugins: hasWriteBundle ? plugins : [...plugins, writeBundlePlugin()],
		};
	} catch (err) {
		console.error(opts, err);
		throw err;
	}
};

export const build = (opts: BuildOptions[]) =>
	opts.map(makeBuildOpts).forEach(async (buildOptions: BuildOptions) => {
		esBuild(buildOptions).catch((err) => {
			console.error(buildOptions, err);
			throw err;
		});
	});

export const watch = (opts: BuildOptions[]) =>
	opts.map(makeBuildOpts).forEach(async (buildOptions: BuildOptions) => {
		const onErr = (err: Error) => {
			console.error(buildOptions, err);
			throw err;
		};
		const ctx = await esContext(buildOptions).catch(onErr);
		ctx.watch().catch(onErr);
	});

export const listen = process.argv.includes("--watch") ? watch : build;
