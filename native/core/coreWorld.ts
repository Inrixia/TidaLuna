// Luna's core world.
//
// Page code (every plugin's render code, TIDAL, anything injected into the page) shares one JS realm, so whatever decides
// trust in that realm can be driven by any of it. Luna's trust decisions (which plugins are installed and enabled, which
// version of their code the user accepted, whose native code may register) are made in the main process instead
// (registry.ts, registryMain.ts), which asks the user in a window of its own (confirmWindow.ts) and checks every native
// registration and native call (NativeModule/index.ts) and every plugin world load (worlds.ts), whoever sends the IPC.
//
// This file runs in the preload's isolated world (Electron runs a contextIsolation preload in its own world, which page
// code can't reach). It is the only code with the raw ipcRenderer. It gives the page:
// - `__LunaCore`: requests the main process answers;
// - a filtered `__ipcRenderer`: no `__LunaCore.*` or `__LunaWorld.*` channel, and only the few others the page needs.
// It also runs plugin worlds (native/worlds.ts): a plugin's world gets the only bridge to its world natives.
//
// Without contextIsolation (tidal-hifi) this file shares the page's realm: page code gets the raw ipcRenderer, only
// main's checks hold, and there are no plugin worlds.
import { unloadableEmitter, type AnyFn } from "@inrixia/helpers";

import { contextBridge, ipcRenderer, webFrame } from "electron";

import type { NetLogEntry, NetRequest, NetResponse } from "./net";
import { worldCsp } from "./hosts";
import { isCoreUrl } from "./policy";
import { pluginUrl, type CorePluginInfo, type PluginPackage } from "./registry";

export type { CorePluginInfo, NetLogEntry, NetRequest, NetResponse };

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
	if (typeof channel !== "string" || channel.startsWith("__LunaCore.") || channel.startsWith("__LunaWorld."))
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

// #region Plugin worlds
// One isolated world per plugin url (see native/worlds.ts). Main loads only the world of an enabled plugin, at the
// version the user accepted, and names a new world id for each load: code an earlier load left running (a timer it
// never handed to onUnload) stays in its own world, whose bridge is off for good
type WorldLoad = { worldId: number; active: boolean };
type WorldState = { current?: WorldLoad; queue: Promise<unknown> };
const worlds = new Map<string, WorldState>();
const worldOf = (url: string) => {
	let world = worlds.get(url);
	if (world === undefined) worlds.set(url, (world = { queue: Promise.resolve() }));
	return world;
};
// One load or unload of a world at a time
const queuedWorld = <T>(world: WorldState, task: () => Promise<T>): Promise<T> => {
	const run = world.queue.then(task, task);
	world.queue = run.catch(() => {});
	return run;
};
const unloadWorldNow = async (world: WorldState) => {
	const load = world.current;
	if (load === undefined || !load.active) return;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		// Its unloads may still call its natives (e.g. to undo what they changed). Like page unloads (render/src/helpers/unloadSet.ts)
		// they get 5s, so a hung one can't keep the plugin from unloading
		await Promise.race([
			// No user gesture: the world's code must not get the frame's user activation
			webFrame.executeJavaScriptInIsolatedWorld(load.worldId, [{ code: "globalThis.__lunaWorldUnload?.()" }], false),
			new Promise((_, reject) => (timeout = setTimeout(() => reject(new Error("[Luna.worlds] Unload took longer than 5s to run...")), 5000))),
		]);
	} finally {
		clearTimeout(timeout);
		load.active = false;
	}
};
const loadWorld = async (url: string) => {
	if (!process.contextIsolated) throw new Error(`[Luna.worlds] ${url} needs contextIsolation for its plugin world`);
	const world = worldOf(url);
	return queuedWorld(world, async () => {
		// The earlier load is stopped either way (its bridge is off): a failed unload of it must not keep the new one from loading
		await unloadWorldNow(world).catch((err) => console.error("[Luna.worlds]", url, err));
		const { worldId, code } = (await ipcRenderer.invoke("__LunaWorld.load", url)) as { worldId: number; code: string };
		// Active before it runs: its top level may already call its natives
		const load: WorldLoad = { worldId, active: true };
		world.current = load;
		// Its own network is closed (hosts.ts worldCsp): luna.fetch below is its way out. Electron applies a world's csp only
		// with a securityOrigin: the page's, as the world had without one
		webFrame.setIsolatedWorldInfo(worldId, { name: `Luna plugin ${url}`, securityOrigin: window.location.origin, csp: worldCsp });
		// This load's bridge only: it stays off once this load is unloaded, whatever loads after it
		contextBridge.exposeInIsolatedWorld(worldId, "__LunaNative", {
			url,
			invoke: (fileName: string, exportName: string, ...args: unknown[]) => {
				if (!load.active) return Promise.reject(new Error(`[Luna.worlds] ${url} is not loaded`));
				return ipcRenderer.invoke("__LunaWorld.invoke", url, fileName, exportName, ...args);
			},
			// luna.fetch for the world's code: main checks the host against this plugin's accepted hosts (core/net.ts)
			fetch: (request: unknown) => {
				if (!load.active) return Promise.reject(new Error(`[Luna.worlds] ${url} is not loaded`));
				return ipcRenderer.invoke("__LunaWorld.fetch", url, request);
			},
		});
		try {
			await webFrame.executeJavaScriptInIsolatedWorld(worldId, [{ code, url: `${url}.world.js` }], false);
		} catch (err) {
			// A world that threw part way runs its unloads for what it set up, and its bridge is off
			await unloadWorldNow(world).catch((unloadErr) => console.error("[Luna.worlds]", url, unloadErr));
			throw err;
		}
	});
};
const unloadWorld = async (url: string) => {
	const world = worlds.get(url);
	if (world !== undefined) await queuedWorld(world, () => unloadWorldNow(world));
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
		// Runs the plugin's world, if main finds it enabled with one
		loadWorld: (url: unknown): Promise<void> => loadWorld(pluginUrl(url)),
		unloadWorld: (url: unknown): Promise<void> => unloadWorld(pluginUrl(url)),
		moveUrl: (from: unknown, to: unknown): Promise<boolean> => ipcRenderer.invoke("__LunaCore.moveUrl", from, to),
		// luna.fetch for page code (render/src/lunaFetch.ts), which names the calling plugin
		fetch: (pluginUrl: unknown, request: unknown, settings?: unknown): Promise<NetResponse> =>
			ipcRenderer.invoke("__LunaCore.fetch", pluginUrl, request, settings),
		networkLog: (): Promise<NetLogEntry[]> => ipcRenderer.invoke("__LunaCore.networkLog"),
		// Strict network (net.ts, injector.ts): a host page code wants that the page's CSP blocks, the user's answers
		askHost: (pluginUrl: unknown, target: unknown): Promise<{ allowed: boolean; reason?: string; answer?: string; notKept?: true }> =>
			ipcRenderer.invoke("__LunaCore.askHost", pluginUrl, target),
		pageConnect: (): Promise<string[]> => ipcRenderer.invoke("__LunaCore.pageConnect"),
		forgetGrant: (url: unknown, entry: unknown): Promise<boolean> => ipcRenderer.invoke("__LunaCore.forgetGrant", url, entry),
		allowStore: (url: unknown): Promise<boolean> => ipcRenderer.invoke("__LunaCore.allowStore", url),
		storeOrigins: (): Promise<string[]> => ipcRenderer.invoke("__LunaCore.storeOrigins"),
		pageStores: (): Promise<string[]> => ipcRenderer.invoke("__LunaCore.pageStores"),
	});
};
// #endregion
