// The main-process side of Luna's plugin registry (registry.ts): its file, its fetches, and the channels the core world
// (coreWorld.ts) forwards the page's `__LunaCore` requests to.
//
// The page's __ipcRenderer refuses every `__LunaCore.*` channel, so only the core world sends these. Main can't tell
// worlds apart though, so nothing here trusts its caller: a request that grants something asks the user first, and the
// checks that use the registry (NativeModule/index.ts, worlds.ts) hold for any caller.
import { app, net } from "electron";

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

import { ipcHandle } from "../ipc";
import { nativeSourcesOf } from "../NativeModule/permissions/verifySource";
import { forgetAnswers } from "../NativeModule/trust";
import { askerFor } from "./confirmWindow";
import { boundedCache } from "./policy";
import { cspSources } from "./hosts";
import { createNet } from "./net";
import { createRegistry, type PluginPackage } from "./registry";

const stateFile = () => path.join(app.getPath("userData"), "luna-core", "plugins.json");

const fetchText = async (url: string) => {
	const res = await net.fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
	if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
	return res.text();
};

// Keyed by the whole bundle: only the last few versions are kept
const sourcesCache = boundedCache<Record<string, string>>(16);

// Created on first use: TIDAL may still change userData while the injector loads
let instance: ReturnType<typeof createRegistry> | undefined;
export const registry = () =>
	(instance ??= createRegistry({
		// Only a missing file starts a fresh registry (the page may then hand over its list, see registry.migrate). A file
		// that can't be read (an antivirus holding it) is tried again a few times, then the request fails and the next one
		// tries again. One that doesn't parse is kept aside
		read: () => {
			const file = stateFile();
			let text: string | undefined;
			for (let attempt = 1; text === undefined; attempt++) {
				try {
					text = readFileSync(file, "utf8");
				} catch (err) {
					if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
					if (attempt >= 5) throw err;
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
				}
			}
			try {
				return JSON.parse(text);
			} catch (err) {
				const aside = `${file}.unreadable-${Date.now()}`;
				renameSync(file, aside);
				console.error(`[Luna.core] ${file} is not valid JSON, kept as ${aside}:`, err);
				return null;
			}
		},
		write: (state) => {
			const file = stateFile();
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(`${file}.tmp`, JSON.stringify(state));
			renameSync(`${file}.tmp`, file);
		},
		fetchPackage: async (url) => {
			const pkg = JSON.parse(await fetchText(`${url}.json`)) as PluginPackage;
			if (typeof pkg?.name !== "string") throw new Error(`${url}.json has no name`);
			delete pkg.code;
			return pkg;
		},
		fetchCode: async (url) => `${await fetchText(`${url}.mjs`)}\n//# sourceURL=${url}.mjs`,
		fetchWorld: (url) => fetchText(`${url}.world.json`),
		nativeSources: (code) => {
			let sources = sourcesCache.get(code);
			if (sources === undefined) sourcesCache.set(code, (sources = Object.fromEntries(nativeSourcesOf(code))));
			return sources;
		},
		forgetAnswers,
		log: (message) => console.log(message),
	}));

ipcHandle("__LunaCore.list", () => registry().list());
ipcHandle("__LunaCore.info", (_, url: unknown) => registry().info(url));
ipcHandle("__LunaCore.needsMigration", () => registry().needsMigration());
ipcHandle("__LunaCore.migrate", (_, entries: unknown) => registry().migrate(entries));
ipcHandle("__LunaCore.load", (_, url: unknown) => registry().load(url));
ipcHandle("__LunaCore.install", (event, url: unknown) => registry().install(url, askerFor(event.sender)));
ipcHandle("__LunaCore.enable", (event, url: unknown) => registry().enable(url, askerFor(event.sender)));
ipcHandle("__LunaCore.acceptUpdate", (event, url: unknown) => registry().acceptUpdate(url, askerFor(event.sender)));
/** Called after a plugin is disabled or uninstalled (worlds.ts lets go of its world's natives) */
const stoppedListeners = new Set<(url: string) => void>();
export const onPluginStopped = (listener: (url: string) => void) => void stoppedListeners.add(listener);
const stopped = (url: unknown) => {
	if (typeof url !== "string" || registry().isEnabled(url)) return;
	for (const listener of stoppedListeners) listener(url);
};
ipcHandle("__LunaCore.disable", async (_, url: unknown) => {
	await registry().disable(url);
	stopped(url);
});
ipcHandle("__LunaCore.uninstall", async (_, url: unknown) => {
	await registry().uninstall(url);
	stopped(url);
});
ipcHandle("__LunaCore.moveUrl", (_, from: unknown, to: unknown) => registry().moveUrl(from, to));

// luna.fetch (net.ts). Node's fetch, not Electron's net: no TIDAL session, so no cookies of the user's account are sent
export const lunaNet = createNet({ hostsOf: (url) => registry().hostsOf(url), fetch: (url, init) => fetch(url, init as RequestInit) });
// The page names the plugin (render/src/lunaFetch.ts finds it from the stack): attribution, not a boundary, see net.ts
ipcHandle("__LunaCore.fetch", (_, pluginUrl: unknown, request: unknown) => lunaNet.fetch(pluginUrl, "page", request));
ipcHandle("__LunaCore.networkLog", () => lunaNet.log());
/** CSP sources for the hosts enabled plugins declare (injector.ts adds them to the report-only header). None if the registry can't be read */
export const pluginCspHosts = (): string[] => {
	try {
		return cspSources(registry().declaredHosts());
	} catch (err) {
		console.error("[Luna.core] Can't read the plugins' hosts for the CSP report-only header:", err);
		return [];
	}
};
ipcHandle("__LunaCore.clearNetworkLog", () => lunaNet.clearLog());
