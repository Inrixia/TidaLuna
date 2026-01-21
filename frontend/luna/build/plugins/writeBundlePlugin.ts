import type { Plugin } from "esbuild";

import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname } from "path";

export const writeBundlePlugin = (pluginPackagePath?: string): Plugin => ({
	name: "writeBundlePlugin",
	setup(build) {
		build.onEnd(async (result) => {
			if (result.errors.length > 0) return;

			let writePackageJson = false;
			for (const outputFile of result.outputFiles ?? []) {
				const outDir = dirname(outputFile.path);
				await mkdir(outDir, { recursive: true });

				await writeFile(outputFile.path, outputFile.contents);
				if (pluginPackagePath && !writePackageJson && outputFile.path.endsWith(".mjs")) {
					const pluginPackage = await readFile(pluginPackagePath, "utf8").then(JSON.parse);
					await writeFile(
						outputFile.path.replace(/\.mjs$/, ".json"),
						JSON.stringify({
							...pluginPackage,
							hash: outputFile.hash,
						}),
					);
					// Only write the package.json once
					writePackageJson = true;
				}

				const fileSizeInBytes = outputFile.contents.byteLength;
				const kB = 1024;
				const showInkB = fileSizeInBytes < kB * kB; // 1 MB in bytes
				const fileSizeDisp = showInkB ? `${(fileSizeInBytes / kB).toFixed(2)}kB` : `${(fileSizeInBytes / (kB * kB)).toFixed(2)}mB`;

				console.log(`Built [${outputFile.hash}] ${fileSizeDisp} ${basename(outputFile.path)}!`);
			}
		});
	},
});
