// Luna's core world.
//
// Page code (every plugin's render code, TIDAL, anything injected into the page) shares one JS realm, so whatever decides
// trust in that realm can be driven by any of it. Luna's trust decisions (which plugins are installed and enabled, which
// version of their code the user accepted, whose native code may register) are made in the main process instead
// (registry.ts, registryMain.ts), which asks the user in a window of its own (confirmWindow.ts) and checks every native
// registration and native call (NativeModule/index.ts), whoever sends the IPC.
//
// This file runs in the preload's isolated world (Electron runs a contextIsolation preload in its own world, which page
// code can't reach). It is the only code with the raw ipcRenderer. It gives the page:
// - `__LunaCore`: requests the main process answers;
// - a filtered `__ipcRenderer`: no `__LunaCore.*` channel, and only the few others the page needs.
//
// Without contextIsolation (tidal-hifi) this file shares the page's realm: page code gets the raw ipcRenderer and only
// main's checks hold.
import { unloadableEmitter, type AnyFn } from "@inrixia/helpers";

import { contextBridge, ipcRenderer } from "electron";

import { isCoreUrl } from "./policy";
import { pluginUrl, type CorePluginInfo, type PluginPackage } from "./registry";

export type { CorePluginInfo };

const securityError = (message: string) => new Error(`[🛑Security🛑] ${message}`);

// #region Page IPC
// What the page's `__ipcRenderer` may still invoke directly: read-only or the user's own settings screens
const pageChannelsAllowed = new Set([
	"__Luna.getSeedSettings",
	"__Luna.nativePermissions.list",
	"__Luna.nativePermissions.revoke",
	"__Luna.getTidalHifiSetting",
	"__Luna.getTidalHifiThemeCSS",
]);
// tidal-hifi's own channels (plugins/linux)
const pageSendAllowed = new Set(["update-info", "showSettings", "hideSettings"]);

const pageInvoke = async (channel: unknown, ...args: unknown[]) => {
	if (typeof channel !== "string") throw new Error("[Luna.core] channel must be a string");
	// A plugin bundle registers its natives when the page imports it (build/plugins/lunaNativePlugin.ts). Main decides
	// whose they are and refuses any but Luna's own and those of an enabled plugin's accepted code (NativeModule/index.ts)
	if (channel === "__Luna.registerNative") return ipcRenderer.invoke("__Luna.registerNative", args[0], args[1]);
	// Main checks the plugin is enabled, and asks the user before the core natives that need it
	if (channel.startsWith("__LunaNative.")) return ipcRenderer.invoke(channel, ...args);
	if (pageChannelsAllowed.has(channel)) return ipcRenderer.invoke(channel, ...args);
	throw securityError(`Channel ${channel} is not available to the page`);
};
const pageSend = (channel: unknown, ...args: unknown[]) => {
	if (typeof channel !== "string" || !pageSendAllowed.has(channel))
		throw securityError(`Channel ${String(channel)} is not available to the page`);
	ipcRenderer.send(channel, ...args);
};
const ipcRendererUnloadable = unloadableEmitter(ipcRenderer, null, "ipcRenderer");
const listenable = (channel: unknown) => {
	if (typeof channel !== "string" || channel.startsWith("__LunaCore."))
		throw securityError(`Channel ${String(channel)} is not available to the page`);
	return channel;
};
// #endregion

// #region Core plugins
// Luna's own plugins are served from its bundle (native/injector.ts): nothing to accept, and main trusts their native
// code by its hash (NativeModule/coreNatives.ts)
const fetchText = async (url: string) => {
	const res = await fetch(url, { cache: "no-store" });
	if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
	return res.text();
};
const loadCore = async (url: string) => {
	const pkg = JSON.parse(await fetchText(`${url}.json`)) as PluginPackage;
	delete pkg.code;
	return { package: pkg, code: `${await fetchText(`${url}.mjs`)}\n//# sourceURL=${url}.mjs` };
};
// #endregion

// #region Exposed to the page
const expose = (name: string, value: unknown) => {
	if (process.contextIsolated) contextBridge.exposeInMainWorld(name, value);
	else (window as any)[name] = value;
};

export const exposeCore = () => {
	expose("__ipcRenderer", {
		invoke: pageInvoke,
		send: pageSend,
		on: (channel: string, listener: AnyFn) => ipcRendererUnloadable.onU(null, listenable(channel), (_, ...args) => listener(...args)),
		once: (channel: string, listener: AnyFn) => ipcRendererUnloadable.onceU(null, listenable(channel), (_, ...args) => listener(...args)),
	});
	// Requests: main answers them, and asks the user before granting anything
	expose("__LunaCore", {
		list: (): Promise<CorePluginInfo[]> => ipcRenderer.invoke("__LunaCore.list"),
		info: (url: unknown): Promise<CorePluginInfo | undefined> => ipcRenderer.invoke("__LunaCore.info", url),
		needsMigration: (): Promise<boolean> => ipcRenderer.invoke("__LunaCore.needsMigration"),
		migrate: (entries: unknown) => ipcRenderer.invoke("__LunaCore.migrate", entries),
		load: (url: unknown) => (isCoreUrl(pluginUrl(url)) ? loadCore(pluginUrl(url)) : ipcRenderer.invoke("__LunaCore.load", url)),
		install: (url: unknown): Promise<boolean> => ipcRenderer.invoke("__LunaCore.install", url),
		enable: (url: unknown): Promise<boolean> => ipcRenderer.invoke("__LunaCore.enable", url),
		acceptUpdate: (url: unknown): Promise<boolean> => ipcRenderer.invoke("__LunaCore.acceptUpdate", url),
		disable: (url: unknown): Promise<void> => ipcRenderer.invoke("__LunaCore.disable", url),
		uninstall: (url: unknown): Promise<void> => ipcRenderer.invoke("__LunaCore.uninstall", url),
	});
};
// #endregion
