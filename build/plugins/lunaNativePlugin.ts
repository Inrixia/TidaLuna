import { build as esBuild, Plugin } from "esbuild";
import path from "path";
import { defaultBuildOptions, TidalNodeVersion } from "../index";
import { dynamicExternalsPlugin } from "./dynamicExternals";
import { fileUrlPlugin } from "./fileUrl";

/**
 * A native file's name as Luna knows it: `pkgName` for the plugin's entry point, else its path with the entry point's
 * folder replaced by `pkgName`. `entryPoint` is esbuild's (relative to `cwd`); `pluginEntryPoint` may be relative or
 * absolute: both are compared relative to `cwd`, with `/`.
 */
export const nativeFileName = (entryPoint: string, pluginEntryPoint: string, pkgName: string, cwd = process.cwd(), p = path) => {
	const rel = (file: string) => p.relative(cwd, p.resolve(cwd, file)).replaceAll("\\", "/");
	const entry = rel(entryPoint);
	if (entry === rel(pluginEntryPoint)) return pkgName;
	const dir = rel(p.dirname(pluginEntryPoint));
	return entry.startsWith(`${dir}/`) ? `${pkgName}${entry.slice(dir.length)}` : entry;
};

/**
 * The files of an esbuild metafile's inputs (relative to `cwd`), absolute, as watchFiles needs them; not virtual ones
 * like "lunaWorldRuntime:@luna/world" or "file-url:..." (a one-letter drive is kept: "C:/...")
 */
export const inputFiles = (inputs: Record<string, unknown>, cwd = process.cwd(), p = path) =>
	Object.keys(inputs)
		.filter((input) => !/^[\w-]{2,}:/.test(input))
		.map((input) => p.resolve(cwd, input));

/** Builds one `*.native.*` file for the main process: its name as Luna knows it, its code and its export names */
export const buildNativeFile = async (nativePath: string, pluginEntryPoint: string, pkgName: string) => {
	const { outputFiles, metafile } = await esBuild({
		...defaultBuildOptions,
		entryPoints: [nativePath],
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
		entryPoints: [nativePath],
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

	const fileName = nativeFileName(output.entryPoint!, pluginEntryPoint, pkgName);

	return { fileName, code: outputFiles![0].text, exportNames, watchFiles: inputFiles(output.inputs) };
};

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
		build.onLoad({ filter: /.*\.native\.[a-z]+/ }, async (args) => {
			const { fileName, code, exportNames, watchFiles } = await buildNativeFile(args.path, pluginEntryPoint, pkgName);
			if (fileName !== undefined) onNativeCode?.(fileName, code);

			return {
				contents: `
					// Register the native module code, see native/injector.ts
					const channel = await __ipcRenderer.invoke("__Luna.registerNative", "${fileName}", ${JSON.stringify(code)});
					if (channel === undefined) throw new Error("Failed to register native module ${fileName}");

					// Expose built exports to plugin
					${exportNames
						.map((_export) => {
							return `export ${_export === "default" ? "default" : `const ${_export}`} = (...args) => __ipcRenderer.invoke(channel, "${_export}", ...args);`;
						})
						.join("\n")}
				`,
				watchFiles,
			};
		});
	},
});
