import { createRequire } from "module";
import { pathToFileURL } from "url";

export const nativeRequire = createRequire(pathToFileURL(process.resourcesPath + "/").href);

import { BrowserWindow } from "electron";
import { ipcHandle } from "../ipc";

import { createHash } from "crypto";
import { askerFor } from "../core/confirmWindow";
import { coreNativeArgsError, coreNativeQuestion, coreNativeRule } from "../core/policy";
import { registry } from "../core/registryMain";
import * as expose from "../expose";
import { isCoreNative } from "./coreNatives";
import { secureLoad } from "./secureLoad";
import { isWorldNative, moduleOwners, worldFilePrefix } from "./worldNatives";

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
	/** Url of the enabled plugin whose accepted code holds this native file (see registerNative) */
	url?: string;
	/** Luna's own core native code, trusted without prompts (see coreNatives.ts) */
	isCore: boolean;
	/** A native file of a plugin world, loaded by the main process from the plugin's accepted world (see native/worlds.ts) */
	world?: {
		/** sha256 of the file's code alone; `hash` also covers the world's code */
		nativeHash: string;
	};
};

const installedVersion = async (pkg: () => Promise<{ version?: unknown }>): Promise<string | undefined> => {
	const version = await pkg().then(({ version }) => version, () => undefined);
	return typeof version === "string" ? version : undefined;
};

/** channel -> Luna's own native code loaded (or loading) for it */
const coreLoads = new Map<string, { hash: string; done: Promise<string> }>();

/**
 * Registers a native file the page's code holds (build/plugins/lunaNativePlugin.ts). Main can't tell who sends this
 * (the core world forwards the page's calls, see core/coreWorld.ts), so it decides the owner itself: Luna's own native
 * code, or the enabled plugin whose accepted code holds this file with this code (core/registry.ts).
 */
const registerNative = async (event: Electron.IpcMainInvokeEvent, fileName: unknown, code: unknown) => {
	if (typeof fileName !== "string" || typeof code !== "string") throw new Error("[Luna.native] fileName and code must be strings");
	const hash = createHash("sha256").update(code, "utf8").digest("hex");
	const channel = `__LunaNative.${fileName}`;
	// A world plugin's natives run only for its world: page code registering them would get a channel of its own
	if (fileName.startsWith(worldFilePrefix) || isWorldNative(hash))
		throw new Error(`[🛑Security🛑] '${fileName}' is native code of a plugin world, it can only be loaded by that world`);
	if (await isCoreNative(hash)) {
		// Luna's own native code is public: page code registering it again must not run its module again
		const loading = coreLoads.get(channel);
		if (loading?.hash === hash) return loading.done;
		const done = loadNative(event, channel, { fileName, code, hash, isCore: true });
		coreLoads.set(channel, { hash, done });
		done.catch(() => coreLoads.get(channel)?.done === done && coreLoads.delete(channel));
		return done;
	}
	const url = registry().nativeOwner(fileName, code);
	if (url === undefined)
		throw new Error(`[🛑Security🛑] '${fileName}' is not native code of an enabled plugin: native code registers only through Luna core`);
	return loadNative(event, channel, { fileName, code, hash, url, isCore: false });
};

/** Runs a native file (in its sandbox, after the user allowed it) and handles its channel */
const loadNative = async (event: Electron.IpcMainInvokeEvent, channel: string, moduleInfo: NativeModuleInfo): Promise<string> => {
	const { fileName, code, url, isCore } = moduleInfo;
	// Other natives import a world's native module by name: page natives can't replace it
	const checkWorldOwner = () => {
		const worldOwner = moduleOwners.get(fileName);
		if (worldOwner !== undefined) throw new Error(`[🛑Security🛑] Native module ${fileName} belongs to the plugin world of ${worldOwner}`);
	};
	checkWorldOwner();
	let exports;
	try {
		exports = await secureLoad(moduleInfo, BrowserWindow.fromWebContents(event.sender) ?? undefined);
	} catch (err) {
		// Not Error.isError: Electron older than 35 lacks it, and calling it here would replace the real error
		const isDepricatedModule = /Cannot use import statement outside a module/i.test(String((err as Error | undefined)?.message));
		if (isDepricatedModule) throw new Error("Plugin using deprecated unsafe native code! Please ask the plugin author to rebuild!");
		throw err;
	}

	// A world may have taken the name while the user was asked
	checkWorldOwner();
	globalThis.luna.modules[fileName] = exports;
	// A plugin's file of the same name replaced Luna's: Luna's registers again
	if (!isCore) coreLoads.delete(channel);

	ipcHandle(channel, async (event, exportName, ...args) => {
		// A plugin's natives work only while it is enabled and its accepted code still holds them (an update may drop or change them)
		if (!isCore && !registry().ownsNative(url!, fileName, code))
			throw new Error(`[🛑Security🛑] ${channel} is not a native channel of an enabled plugin`);
		// Luna's own natives are open to all page code: some may not be called from there, some only after the user confirms
		if (isCore) {
			// One name for the rule, the question and the call: another type could pass the rule as one name and run as another
			if (typeof exportName !== "string") throw new Error(`[🛑Security🛑] Export names must be strings`);
			const rule = coreNativeRule(exportName);
			if (rule === "deny") throw new Error(`[🛑Security🛑] ${exportName} can't be called from the page`);
			if (rule === "confirm") {
				// Nothing to confirm for a call that can't run: the window would show the page's text for nothing
				if (typeof exports[exportName] !== "function") throw new Error(`[Luna.native] (${fileName}) has no export ${exportName}`);
				const invalid = coreNativeArgsError(exportName, args);
				if (invalid !== undefined) throw new Error(`[Luna.native] ${invalid}`);
				// update.ts exports pkg: the installed version shows next to the one asked for
				const current = exportName === "update" && typeof exports.pkg === "function" ? await installedVersion(exports.pkg) : undefined;
				const [title, lines, confirmText] = coreNativeQuestion(exportName, args, current);
				if (!(await askerFor(event.sender)({ title, lines, confirmText }))) throw new Error(`[Luna] ${exportName} cancelled by the user`);
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

ipcHandle("__Luna.registerNative", (event, fileName: unknown, code: unknown) => registerNative(event, fileName, code));
