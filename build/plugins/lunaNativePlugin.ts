import { build as esBuild, Plugin } from "esbuild";
import path from "path";
import { defaultBuildOptions, TidalNodeVersion } from "../index";
import { dynamicExternalsPlugin } from "./dynamicExternals";
import { fileUrlPlugin } from "./fileUrl";

import { createRequire } from "module";

export const lunaNativePlugin = (pluginEntryPoint: string, pkgName: string): Plugin => ({
	name: "lunaNativePlugin",
	setup(build) {
		pluginEntryPoint = pluginEntryPoint.replaceAll("\\", "/");

		build.onResolve({ filter: /\.native$/ }, async (args) => {
			try {
				const req = createRequire(args.resolveDir && args.resolveDir !== "/" ? args.resolveDir + "/" : process.cwd() + "/");
				const resolved = req.resolve(args.path);
				return { path: resolved, namespace: "file" };
			} catch (e) {
				return null;
			}
		});

		build.onLoad({ filter: /.*\.native\.[a-z]+/ }, async (args) => {
			const relativePath = args.path.replaceAll("\\", "/");
			const nativeEntry = pluginEntryPoint === relativePath;

			const safeFilename = `${pkgName.replace(/[^a-zA-Z0-9]/g, "_")}_${path.basename(args.path).replace(/\.[^.]+$/, "")}.native.mjs`;
			const outFile = path.join("dist", safeFilename);

			const { outputFiles, metafile } = await esBuild({
				...defaultBuildOptions,
				entryPoints: [args.path],
				write: true,
				outfile: outFile,
				metafile: true,
				sourcemap: false,
				platform: "node",
				target: TidalNodeVersion,
				format: "esm",
				external: ["electron", "./app/package.json", "./original.asar/*"],
				banner: {
					js: `import { createRequire } from 'module'; import { pathToFileURL } from 'url'; const require = createRequire(pathToFileURL(process.resourcesPath + "/").href); `,
				},
				plugins: [
					{
						name: "self-import",
						setup(b) {
							const filter = new RegExp(`^${pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
							b.onResolve({ filter }, () => ({ path: args.path }));
						},
					},
					fileUrlPlugin,
					dynamicExternalsPlugin({
						moduleContents: (module: string) => `
			module.exports = globalThis.luna.modules["${module}"];
			if (module.exports === undefined) throw new Error("Cannot find native module ${module} in globalThis.luna.modules");
			globalThis.luna.tidalWindow.webContents.send("__Luna.LunaPlugin.addDependant", "${module}", "${pkgName}");
			`,
						externals: ["@luna/*"],
					}),
				],
			});

			const output = Object.values(metafile!.outputs)[0];
			const isMainEntry = nativeEntry;
			const channelId = isMainEntry ? pkgName : `${pkgName}/${path.basename(args.path)}`;

			return {
				contents: `
					const channel = await __ipcRenderer.invoke("__Luna.loadNative", "${safeFilename}", "${channelId}");
					if (channel === undefined) throw new Error("Failed to load native module ${channelId}");

					${output.exports
						.map((_export) => {
							return `export ${_export === "default" ? "default" : `const ${_export}`} = (...args) => __ipcRenderer.invoke(channel, "${_export}", ...args);`;
						})
						.join("\n")}
				`,
				watchFiles: Object.keys(output.inputs),
			};
		});
	},
});
