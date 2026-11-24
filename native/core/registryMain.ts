// The main-process side of Luna's plugin registry (registry.ts): its file, its fetches, and the channels the core world
// (coreWorld.ts) forwards the page's `__LunaCore` requests to.
//
// The page's __ipcRenderer refuses every `__LunaCore.*` channel, so only the core world sends these. Main can't tell
// worlds apart though, so nothing here trusts its caller: a request that grants something asks the user first, and the
// checks that use the registry (NativeModule/index.ts, worlds.ts) hold for any caller.
import { app, net } from "electron";

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

import { ipcHandle } from "../ipc";
import { nativeSourcesOf } from "../NativeModule/permissions/verifySource";
import { forgetAnswers } from "../NativeModule/trust";
import { askerFor } from "./confirmWindow";
import { legacyAllows, legacyListReady } from "./legacyListMain";
import { boundedCache } from "./policy";
import { createRegistry, type PluginPackage } from "./registry";

const stateFile = () => path.join(app.getPath("userData"), "luna-core", "plugins.json");
const migratedFile = () => path.join(app.getPath("userData"), "luna-core", "migrated");

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
		legacyAllows,
		legacyReady: legacyListReady,
		wasMigrated: () => existsSync(migratedFile()),
		markMigrated: () => {
			mkdirSync(path.dirname(migratedFile()), { recursive: true });
			writeFileSync(migratedFile(), "");
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
/**
 * Called after a request that may change what a plugin runs (disabled, uninstalled, updated, moved), whether it went
 * through or not: worlds.ts lets go of natives of a world that isn't the accepted one any more
 */
const changeListeners = new Set<(url: string) => void>();
export const onPluginChanged = (listener: (url: string) => void) => void changeListeners.add(listener);
const thenChanged = async <T>(urls: unknown[], task: () => Promise<T>): Promise<T> => {
	try {
		return await task();
	} finally {
		for (const url of urls) if (typeof url === "string") for (const listener of changeListeners) listener(url);
	}
};
ipcHandle("__LunaCore.load", (_, url: unknown) => thenChanged([url], () => registry().load(url)));
ipcHandle("__LunaCore.install", (event, url: unknown) => thenChanged([url], () => registry().install(url, askerFor(event.sender))));
ipcHandle("__LunaCore.enable", (event, url: unknown) => thenChanged([url], () => registry().enable(url, askerFor(event.sender))));
ipcHandle("__LunaCore.acceptUpdate", (event, url: unknown) => thenChanged([url], () => registry().acceptUpdate(url, askerFor(event.sender))));
ipcHandle("__LunaCore.disable", (_, url: unknown) => thenChanged([url], () => registry().disable(url)));
ipcHandle("__LunaCore.uninstall", (_, url: unknown) => thenChanged([url], () => registry().uninstall(url)));
ipcHandle("__LunaCore.moveUrl", (_, from: unknown, to: unknown) => thenChanged([from, to], () => registry().moveUrl(from, to)));
