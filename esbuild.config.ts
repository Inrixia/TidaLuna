import { type BuildOptions, type PluginBuild } from "esbuild";
import { defaultBuildOptions, listen, TidalNodeVersion } from "luna/build";

import { mkdir, readFile, writeFile, cp } from "fs/promises";

const packageJsonPlugin = {
	name: "write-package-json",
	setup(build: PluginBuild) {
		build.onEnd(async () => {
			await mkdir("./dist", { recursive: true });
			await writeFile("./dist/package.json", await readFile("./package.json", "utf-8"));
		});
	},
};

const copyAssetsPlugin = {
	name: "copy-assets",
	setup(build: PluginBuild) {
		build.onEnd(async () => {
			try {
				await cp("/tmp/tidal-original/assets", "./dist/assets", { recursive: true });
				console.log("Copied assets to dist/");
			} catch (err) {
				console.warn("Failed to copy assets:", err);
			}
		});
	},
};

const buildConfigs: BuildOptions[] = [
	{
		...defaultBuildOptions,
		entryPoints: ["native/injector.ts"],
		outfile: "dist/injector.mjs",
		target: TidalNodeVersion,
		format: "esm",
		platform: "node",
		external: ["electron", "module"],
		plugins: [packageJsonPlugin, copyAssetsPlugin],
	},
	{
		...defaultBuildOptions,
		entryPoints: ["native/preload.ts"],
		outfile: "dist/preload.mjs",
		platform: "node",
		target: TidalNodeVersion,
		format: "esm",
		external: ["electron"],
		plugins: [packageJsonPlugin],
	},
	{
		...defaultBuildOptions,
		entryPoints: ["render/src/index.ts"],
		outfile: "dist/luna.mjs",
		target: TidalNodeVersion,
		platform: "browser",
		format: "esm",
	},
];

import "build/buildPlugins";
listen(buildConfigs);
