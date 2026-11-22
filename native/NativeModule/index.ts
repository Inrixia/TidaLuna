import { createRequire } from "module";
import { pathToFileURL } from "url";

export const nativeRequire = createRequire(pathToFileURL(process.resourcesPath + "/").href);

import { BrowserWindow } from "electron";
import { ipcHandle } from "../ipc";

import { createHash } from "crypto";
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
		const isDepricatedModule = Error.isError(err) && /Cannot use import statement outside a module/i.test(err.message);
		if (isDepricatedModule) throw new Error("Plugin using deprecated unsafe native code! Please ask the plugin author to rebuild!");
		throw err;
	}

	globalThis.luna.modules[fileName] = exports;
	const channel = `__LunaNative.${fileName}`;

	ipcHandle(channel, async (_, exportName, ...args) => {
		try {
			return await exports[exportName](...args);
		} catch (err: any) {
			err.cause = `[Luna.native] (${fileName}).${exportName}`;
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
