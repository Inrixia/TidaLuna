// Preload of an isolated native host (see ./index.ts). The host is a sandboxed renderer: no Node, no Electron beyond
// this file's ipcRenderer. Plugin code runs in the page's main world and reaches this file only through `__lunaNativeHost`.
import { contextBridge, ipcRenderer, webFrame } from "electron";

import type { HostModule, SyncResult } from "./syncModules";

// An exception crossing from the main world to this file keeps only its message, so the handler reports as plain data instead
type CallResult = { ok: true; value: unknown } | { ok: false; isError: boolean; error: unknown };
type CallHandler = (exportName: string, args: unknown[]) => Promise<CallResult>;
type HostInit = { fileName: string; code: string; modules: Record<string, HostModule> };

let callHandler: CallHandler | undefined;
let exportNames: string[] = [];

const bridge = {
	/** Runs a function of a module listed in native/NativeModule/isolated/syncModules.ts in the main process */
	callSync: (moduleName: string, fn: string, args: unknown[]) => {
		const result: SyncResult = ipcRenderer.sendSync("__LunaNativeHost.callSync", moduleName, fn, args);
		if ("error" in result) throw new Error(result.error);
		return result.value;
	},
	ready: (names: string[], handler: CallHandler) => {
		exportNames = names;
		callHandler = handler;
	},
};
contextBridge.exposeInMainWorld("__lunaNativeHost", bridge);

ipcRenderer.on("__LunaNativeHost.call", async (_, id: number, exportName: string, args: unknown[]) => {
	try {
		if (callHandler === undefined) throw new Error("Native module is not loaded");
		const result = await callHandler(exportName, args);
		if (result.ok) ipcRenderer.send("__LunaNativeHost.result", id, true, result.value);
		else ipcRenderer.send("__LunaNativeHost.result", id, false, result.error, result.isError);
	} catch (err) {
		// What the module returned or threw can't be sent, or its code replaced the handler with one that throws
		const message = err instanceof Error ? err.message : String(err);
		ipcRenderer.send("__LunaNativeHost.result", id, false, { name: "Error", message }, true);
	}
});

// The main process asks for it while calls wait: no answer means the code keeps this thread busy (see ./index.ts)
ipcRenderer.on("__LunaNativeHost.ping", () => ipcRenderer.send("__LunaNativeHost.pong"));

// Runs in the main world, passed there as source text: must not use anything outside its own body.
const loadInMainWorld = (fileName: string, code: string, modules: Record<string, HostModule>) => {
	const host: typeof bridge = (globalThis as any).__lunaNativeHost;
	// Taken before the code runs: it could replace them, and its own failure would then be told wrong
	const toText = String;
	const ErrorType = Error;

	const loaded: Record<string, Record<string, unknown>> = {};
	for (const moduleName in modules) {
		const module: Record<string, unknown> = (loaded[moduleName] = { ...modules[moduleName].constants });
		for (const fn of modules[moduleName].functions) module[fn] = (...args: unknown[]) => host.callSync(moduleName, fn, args);
	}
	for (const moduleName in modules) {
		const { submodules } = modules[moduleName];
		for (const prop in submodules) loaded[moduleName][prop] = loaded[submodules[prop]];
	}

	const require = (name: string) => {
		const moduleName = String(name).replace(/^node:/, "");
		if (Object.hasOwn(loaded, moduleName)) return loaded[moduleName];
		throw new Error(`'${moduleName}' is not available to isolated native code ('${fileName}')`);
	};

	const module = { exports: {} as Record<string, unknown> };
	try {
		new Function(
			"module",
			"exports",
			"require",
			"global",
			`${code}
//# sourceURL=luna://${fileName}`,
		)(module, module.exports, require, globalThis);

		// Still the code's doing if this throws: what it exported may be no object, or have getters that throw
		const exports = module.exports;
		host.ready(
			Object.keys(exports).filter((name) => typeof exports[name] === "function"),
			async (exportName, args) => {
				try {
					if (!Object.hasOwn(exports, exportName) || typeof exports[exportName] !== "function") {
						throw new Error(`'${exportName}' is not an exported function of '${fileName}'`);
					}
					return { ok: true, value: await (exports[exportName] as (...args: unknown[]) => unknown)(...args) };
				} catch (err) {
					if (err instanceof Error) return { ok: false, isError: true, error: { name: err.name, message: err.message, stack: err.stack } };
					return { ok: false, isError: false, error: err };
				}
			},
		);
	} catch (err) {
		// A throw here would reach the preload without its message, and not as the code's own
		try {
			return toText(err instanceof ErrorType ? (err.stack ?? err.message) : err);
		} catch {
			return "threw a value that cannot be shown";
		}
	}
};

(async () => {
	let thrownByCode = false;
	try {
		const { fileName, code, modules }: HostInit = await ipcRenderer.invoke("__LunaNativeHost.init");
		const error: string | undefined = await webFrame.executeJavaScript(
			`(${loadInMainWorld})(${JSON.stringify(fileName)}, ${JSON.stringify(code)}, ${JSON.stringify(modules)})`,
		);
		thrownByCode = error !== undefined;
		if (error !== undefined) throw new Error(error);
		await ipcRenderer.invoke("__LunaNativeHost.loaded", { exportNames });
	} catch (err) {
		// Nobody is left to tell if the host is being closed (e.g. its load timed out)
		await ipcRenderer.invoke("__LunaNativeHost.loaded", { error: err instanceof Error ? err.message : String(err), thrownByCode }).catch(() => {});
	}
})();
