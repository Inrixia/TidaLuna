import { createRequire } from "module";
import { pathToFileURL } from "url";

export const nativeRequire = createRequire(pathToFileURL(process.resourcesPath + "/").href);

import { BrowserWindow } from "electron";
import { ipcHandle } from "../ipc";

import { createHash } from "crypto";
import { askerFor } from "../core/confirmWindow";
import { coreNativeQuestion, coreNativeRule } from "../core/policy";
import * as expose from "../expose";
import { isCoreNative } from "./coreNatives";
import { secureLoad } from "./secureLoad";

declare global {
	var luna: {
		modules: Record<string, any>;
		sendToRender: Electron.WebContents["send"];
	} & typeof expose;
}
export const luna = (globalThis.luna = {
	modules: {},
	sendToRender: (() => {}) as Electron.WebContents["send"],
	...expose,
});

export type NativeModuleInfo = {
	fileName: string;
	code: string;
	hash: string;
	/** Url of the plugin that registers the code, as the renderer names it (see LunaPlugin.loadExports). Not trusted as is */
	url?: string;
	/** Luna's own core native code, trusted without prompts (see coreNatives.ts) */
	isCore: boolean;
};

const registerNative = async (event: Electron.IpcMainInvokeEvent, fileName: string, code: string, url?: string) => {
	const hash = createHash("sha256").update(code, "utf8").digest("hex");

	const moduleInfo: NativeModuleInfo = {
		hash,
		fileName,
		code,
		url,
		isCore: await isCoreNative(hash),
	};

	let exports;
	try {
		exports = await secureLoad(moduleInfo, BrowserWindow.fromWebContents(event.sender) ?? undefined);
	} catch (err) {
		// Not Error.isError: Electron older than 35 lacks it, and calling it here would replace the real error
		const isDepricatedModule = /Cannot use import statement outside a module/i.test(String((err as Error | undefined)?.message));
		if (isDepricatedModule) throw new Error("Plugin using deprecated unsafe native code! Please ask the plugin author to rebuild!");
		throw err;
	}

	globalThis.luna.modules[fileName] = exports;
	const channel = `__LunaNative.${fileName}`;

	ipcHandle(channel, async (event, exportName, ...args) => {
		// Luna's own natives are open to all page code: some may not be called from there, some only after the user confirms
		if (moduleInfo.isCore) {
			const rule = coreNativeRule(String(exportName));
			if (rule === "deny") throw new Error(`[🛑Security🛑] ${String(exportName)} can't be called from the page`);
			if (rule === "confirm") {
				const [title, lines, confirmText] = coreNativeQuestion(String(exportName), args);
				if (!(await askerFor(event.sender)({ title, lines, confirmText }))) throw new Error(`[Luna] ${String(exportName)} cancelled by the user`);
			}
		}
		try {
			return await exports[exportName](...args);
		} catch (err: any) {
			// Native code can throw anything, and setting a property on a primitive throws in its place
			if (typeof err === "object" && err !== null) err.cause = `[Luna.native] (${fileName}).${exportName}`;
			throw err;
		}
	});

	return channel;
};

// The renderer names the plugin's url (see LunaPlugin.loadExports); bundles loaded some other way register without one
ipcHandle("__Luna.registerNative", (event, fileName: string, code: string) => registerNative(event, fileName, code));
ipcHandle("__Luna.registerNativeFrom", (event, url: unknown, fileName: string, code: string) =>
	registerNative(event, fileName, code, typeof url === "string" ? url : undefined),
);
