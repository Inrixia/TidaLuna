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

const buildConfigs: BuildOptions[] = [
	{
		...defaultBuildOptions,
		entryPoints: ["native/injector.ts"],
		outfile: "dist/injector.mjs",
		target: TidalNodeVersion,
		format: "esm",
		platform: "node",
		external: ["electron", "module"],
		plugins: [packageJsonPlugin],
		banner: {
			js: `import { createRequire } from 'module'; import { pathToFileURL } from 'url'; const require = createRequire(import.meta.url);`,
		},
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
