import { type BuildOptions, type Plugin } from "esbuild";

import { createHash } from "crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";

import { listen, pluginBuildOptions } from ".";

const pkg = JSON.parse(await readFile(join(process.cwd(), "./package.json"), "utf8"));

// Luna's own build: sha256 of the core plugins' native code, the injector runs exactly this code without trust prompts (see native/NativeModule/coreNatives.ts)
const coreNatives = new Set<string>();
const nativesPath = join(process.cwd(), "./dist/luna.natives.json");
let writingCoreNatives = Promise.resolve();
const writeCoreNatives: Plugin = {
	name: "writeCoreNatives",
	setup(build) {
		build.onEnd((result) => {
			if (result.errors.length > 0) return;
			// Plugins build in parallel, each writes the list built so far, one write at a time
			writingCoreNatives = writingCoreNatives
				.then(async () => {
					await mkdir(join(process.cwd(), "./dist"), { recursive: true });
					// Write then rename, so the injector never reads a half-written list
					await writeFile(`${nativesPath}.tmp`, JSON.stringify([...coreNatives]));
					await rename(`${nativesPath}.tmp`, nativesPath);
				})
				.catch((err) => console.error("Failed to write dist/luna.natives.json", err));
			return writingCoreNatives;
		});
	},
};
const onNativeCode = (_fileName: string, code: string) => coreNatives.add(createHash("sha256").update(code, "utf8").digest("hex"));

const pluginFolders = await readdir(join(process.cwd(), "./plugins"));
const buildConfigs: BuildOptions[] = await Promise.all(
	pluginFolders.map((name) =>
		pkg.name === "luna"
			? pluginBuildOptions(`./plugins/${name}`, { plugins: [writeCoreNatives] }, onNativeCode)
			: pluginBuildOptions(`./plugins/${name}`),
	),
);

listen(buildConfigs);

// Quick export of plugins for store functionality
pkg.plugins ??= buildConfigs.map((config) => config.outfile?.replace("./dist/", ""));
await mkdir(join(process.cwd(), "./dist"), { recursive: true });
await writeFile(join(process.cwd(), "./dist/store.json"), JSON.stringify(pkg));
