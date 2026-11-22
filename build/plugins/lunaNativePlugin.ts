import { build as esBuild, Plugin } from "esbuild";
import path from "path";
import { defaultBuildOptions, TidalNodeVersion } from "../index";
import { dynamicExternalsPlugin } from "./dynamicExternals";
import { fileUrlPlugin } from "./fileUrl";

/**
 * @param onNativeCode Called with each native module's name and built code, which is what `__Luna.registerNative` receives
 */
export const lunaNativePlugin = (
	pluginEntryPoint: string,
	pkgName: string,
	onNativeCode?: (fileName: string, code: string) => void,
): Plugin => ({
	name: "lunaNativePlugin",
	setup(build) {
		pluginEntryPoint = pluginEntryPoint.replaceAll("\\", "/");
		build.onLoad({ filter: /.*\.native\.[a-z]+/ }, async (args) => {
			const { outputFiles, metafile } = await esBuild({
				...defaultBuildOptions,
				entryPoints: [args.path],
				write: false,
				metafile: true,
				sourcemap: false,
				platform: "node",
				target: TidalNodeVersion, // Tidal node version
				format: "cjs",
				external: ["@luna/*", "electron", "./app/package.json", "./original.asar/*"],
				plugins: [
					fileUrlPlugin,
					dynamicExternalsPlugin({
						moduleContents: (module: string) => `
							module.exports = luna.modules["${module}"];
							if (module.exports === undefined) throw new Error("Cannot find native module ${module} in luna.modules");
							// Register this plugin as a dependant of the native module's plugin (see LunaPlugin "__Luna.LunaPlugin.addDependant")
							luna.sendToRender("__Luna.LunaPlugin.addDependant", "${module}", "${pkgName}");
						`,
						// Override externals as we dont want to dyanmic resolve electron or ./original.asar etc
						externals: ["@luna/*"],
					}),
				],
			});

			const esmBuild = await esBuild({
				...defaultBuildOptions,
				entryPoints: [args.path],
				write: false,
				metafile: true,
				bundle: true,
				platform: "node",
				format: "esm",
				external: ["@luna/*", "electron", "./app/package.json", "./original.asar/*"],
				plugins: [fileUrlPlugin],
			});

			// Extract the export names from the ESM metadata
			const esmOutput = Object.values(esmBuild.metafile!.outputs).find((o) => o.entryPoint);
			const exportNames = esmOutput?.exports || [];

			const output = Object.values(metafile!.outputs)[0];

			// If the plugin entryPoint is this, then use the pkgName as the entryPoint for native module resolution
			const nativeEntry = pluginEntryPoint === output.entryPoint;

			// sanitize output.entryPoint by removing pluginEntryPoint path from it making it relative
			const entryPoint = nativeEntry ? pkgName : output.entryPoint?.replaceAll(path.dirname(pluginEntryPoint), pkgName);
			if (entryPoint !== undefined) onNativeCode?.(entryPoint, outputFiles![0].text);

			return {
				contents: `
					// Register the native module code, see native/injector.ts
					const channel = await __ipcRenderer.invoke("__Luna.registerNative", "${entryPoint}", ${JSON.stringify(outputFiles![0].text)});
					if (channel === undefined) throw new Error("Failed to register native module ${entryPoint}");

					// Expose built exports to plugin
					${exportNames
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
