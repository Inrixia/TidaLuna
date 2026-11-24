// The main-process side of Luna's plugin registry (registry.ts): its file, its fetches, and the channels the core world
// (coreWorld.ts) forwards the page's `__LunaCore` requests to.
//
// The page's __ipcRenderer refuses every `__LunaCore.*` channel, so only the core world sends these. Main can't tell
// worlds apart though, so nothing here trusts its caller: a request that grants something asks the user first, and the
// checks that use the registry (NativeModule/index.ts, worlds.ts) hold for any caller.
import { app, net } from "electron";

import { lookup } from "dns/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

import { ipcHandle } from "../ipc";
import { nativeSourcesOf } from "../NativeModule/permissions/verifySource";
import { forgetAnswers } from "../NativeModule/trust";
import { askerFor, choiceAskerFor } from "./confirmWindow";
import { derivedHosts, derivedHostsReady } from "./derivedHostsMain";
import { legacyAllows, legacyHosts, legacyListLoaded, legacyListReady } from "./legacyListMain";
import { boundedCache } from "./policy";
import { baselineEntries } from "../cspReportOnly";
import { cspSources } from "./hosts";
import { createNet, type AskHost, type HostAnswer } from "./net";
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
		legacyLoaded: legacyListLoaded,
		legacyHosts,
		derivedHosts,
		derivedReady: derivedHostsReady,
		storeBaseline: baselineEntries,
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
// A plugin installed again later, or another at the old url, starts without the "only now" answers (net.ts)
ipcHandle("__LunaCore.uninstall", (_, url: unknown) =>
	thenChanged([url], () =>
		registry()
			.uninstall(url)
			.then((done) => (forgetHostAnswers(url), done)),
	),
);
ipcHandle("__LunaCore.moveUrl", (_, from: unknown, to: unknown) =>
	thenChanged([from, to], () =>
		registry()
			.moveUrl(from, to)
			.then((done) => (done === true && forgetHostAnswers(from), done)),
	),
);
ipcHandle("__LunaCore.allowStore", (event, url: unknown) => registry().allowStore(url, askerFor(event.sender)));
ipcHandle("__LunaCore.storeOrigins", () => registry().storeOrigins());

// luna.fetch (net.ts). Node's fetch, not Electron's net: no session and no cookie jar, so no cookies of the user's
// account are sent, and none a response sets reach another plugin. It doesn't use the system's proxy settings
export const lunaNet = createNet({
	hostsOf: (url) => registry().hostsOf(url),
	grant: (pluginUrl, entry, grant) => registry().grantHost(pluginUrl, entry, grant),
	fetch: (url, init) => fetch(url, init as RequestInit),
	resolve: async (hostname) => (await lookup(hostname, { all: true })).map(({ address }) => address),
});
const forgetHostAnswers = (url: unknown) => typeof url === "string" && lunaNet.forget(url);

const reasons: Record<string, string> = {
	unlisted: "The plugin lists no hosts, and luna-registry has none for this version.",
	unconfirmed: "Installed before Luna checked plugins' hosts: you haven't seen the ones it lists, so each host is asked.",
	"not-listed": "This host is not in the hosts you accepted for it.",
	"local-setting": "A local address, from the server in one of its settings.",
	redirect: "A host it was redirected to.",
	"resolves-local":
		"This name points to an address on your own network (a home server, or a name made to reach your router). Allow it only if you run that server.",
};
/** Asks the user of `sender` about a host for luna.fetch (net.ts), in Luna's own window */
export const hostAskerFor =
	(sender: Electron.WebContents): AskHost =>
	async (question) => {
		const choice = await choiceAskerFor(sender)(
			`Allow ${question.name} to connect to ${new URL(question.entry).host}?`,
			[
				`Plugin: ${question.name} (${question.plugin})`,
				`Host: ${question.entry}`,
				`Example: ${question.example}`,
				reasons[question.reason] ?? "",
				question.reason === "resolves-local"
					? "Only now and Always allow it until TIDAL restarts. Deny lasts until restart too."
					: question.notKept
						? "Luna can't keep an answer for this host: Only now, Always and Deny all last until TIDAL restarts."
						: "Only now allows it until TIDAL restarts. Always and Deny are remembered for this plugin: Luna Settings > Network shows them and can take them back.",
			],
			[
				{ id: "deny", label: "Deny" },
				{ id: "once", label: "Only now" },
				{ id: "always", label: "Always allow" },
			],
		);
		return choice === "deny" || choice === "once" || choice === "always" ? (choice as HostAnswer) : undefined;
	};

// The page names the plugin (render/src/lunaFetch.ts finds it from the stack): attribution, not a boundary, see net.ts.
// `settings`: the values of the plugin's settings its `{setting:<key>}` entries name, as the page has them
ipcHandle("__LunaCore.fetch", (event, pluginUrl: unknown, request: unknown, settings: unknown) =>
	lunaNet.fetch(pluginUrl, "page", request, hostAskerFor(event.sender), settings),
);
/**
 * A request page code makes with the page's own network (render/src/pageNet.ts) to a host the page's CSP doesn't allow:
 * asks the user about it for the calling plugin, like luna.fetch. "always" takes effect in the page from its next load
 */
ipcHandle("__LunaCore.askHost", (event, pluginUrl: unknown, target: unknown, settings: unknown) =>
	lunaNet.ask(pluginUrl, target, hostAskerFor(event.sender), settings),
);
ipcHandle("__LunaCore.networkLog", () => lunaNet.log());
ipcHandle("__LunaCore.forgetGrant", (event, url: unknown, entry: unknown) => registry().forgetGrant(url, entry, askerFor(event.sender)));

/** What the page's connect-src allows besides TIDAL and Luna: hosts of enabled plugins (registry.ts pageHosts) */
export const pluginPageHosts = (): string[] => {
	try {
		return registry().pageHosts();
	} catch (err) {
		console.error("[Luna.core] Can't read the plugins' hosts for the page's CSP:", err);
		return [];
	}
};
/** Store origins Luna reads plugins from (stores.ts): the page's connect-src lists them for Luna's own store reads */
export const pluginStoreOrigins = (): string[] => {
	try {
		return registry().storeOrigins();
	} catch (err) {
		console.error("[Luna.core] Can't read the store origins for the page's CSP:", err);
		return [];
	}
};
/** The same as CSP sources (injector.ts, when the TIDAL shell loads: a plugin enabled later is in it from the next reload) */
export const pluginCspHosts = (): string[] => cspSources(pluginPageHosts());
/** The entries the page's connect-src was built from at its last load: render/src/pageNet.ts reads them */
let pageConnect: string[] = [];
export const setPageConnect = (entries: string[]) => void (pageConnect = entries);
ipcHandle("__LunaCore.pageConnect", () => pageConnect);
/** The store origins in that connect-src: what Luna's UI can read now, without a reload (plugins/ui allowSource.ts) */
let pageStores: string[] = [];
export const setPageStores = (origins: string[]) => void (pageStores = origins);
ipcHandle("__LunaCore.pageStores", () => pageStores);
