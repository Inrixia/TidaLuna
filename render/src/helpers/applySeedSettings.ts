import * as ftch from "./fetch";

import { LunaPlugin, type LunaPluginStorage } from "../LunaPlugin";
import { ReactiveStore } from "../ReactiveStore";
import { coreTrace } from "../trace";

const { trace } = coreTrace.withSource(".applySeedSettings");

/**
 * Shape of luna-settings.json (written by nix/home-manager.nix).
 * Every key is optional, a missing key leaves that part of the user's setup untouched.
 */
export type SeedSettings = {
	/** Plugins to keep installed, any other non core plugin is removed. Matched against the package name or the store entry name */
	plugins?: string[];
	/**
	 * Values written into ReactiveStores, laid out as devtools shows them: store name → key → value.
	 * A plain object is merged over the stored object (undeclared keys are kept), anything else replaces the stored value.
	 * e.g. `{ "@luna/pluginStores": { "storeUrls": [...] }, "@luna/pluginStorage": { "DiscordRPC": { "displayOnPause": false } } }`
	 */
	storage?: Record<string, Record<string, unknown>>;
};

const urlName = (url?: string) => url?.slice(url.lastIndexOf("/") + 1);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Apply a declarative luna-settings.json from the bundle dir, if there is one.
 * Runs before LunaPlugin.loadStoredPlugins so undeclared plugins are never loaded.
 */
export async function applySeedSettings(): Promise<void> {
	let seed: SeedSettings | null;
	try {
		seed = await __ipcRenderer.invoke("__Luna.getSeedSettings");
	} catch (err) {
		return trace.msg.err.withContext("Failed to read luna-settings.json")(err);
	}
	if (!isObject(seed)) return;
	trace.log("Applying luna-settings.json");

	try {
		if (isObject(seed.storage)) {
			// Only the declared keys are touched, everything else in a store is kept
			for (const [storeName, values] of Object.entries(seed.storage)) {
				if (!isObject(values)) continue;
				const store = ReactiveStore.getStore(storeName);
				for (const [key, value] of Object.entries(values)) {
					const stored = await store.get(key);
					await store.set(key, isObject(value) && isObject(stored) ? { ...stored, ...value } : value);
				}
			}
		}

		if (Array.isArray(seed.plugins)) {
			const missing = await removeUndeclaredPlugins(seed.plugins.filter((id) => typeof id === "string"));
			// Install in the background so a slow store doesn't block startup
			if (missing.size !== 0) {
				const storeUrls = await ReactiveStore.getStore("@luna/pluginStores").getReactive<string[]>("storeUrls", []);
				installPlugins(missing, [...storeUrls]).catch(trace.msg.err.withContext("Failed to install plugins from luna-settings.json"));
			}
		}
	} catch (err) {
		trace.msg.err.withContext("Failed to apply luna-settings.json")(err);
	}
}

/**
 * Remove every stored plugin that isn't declared (core plugins are kept).
 * Returns the declared ids (lowercase → as written) that aren't installed yet.
 */
async function removeUndeclaredPlugins(declaredIds: string[]): Promise<Map<string, string>> {
	const missing = new Map(declaredIds.map((id) => [id.toLowerCase(), id]));
	const declared = new Set(missing.keys());
	for (const name of await LunaPlugin.pluginStorage.keys()) {
		if (LunaPlugin.corePlugins.has(name)) continue;
		const stored = await LunaPlugin.pluginStorage.get<LunaPluginStorage>(name);
		const ids = [name, urlName(stored?.url)].filter((id) => id !== undefined).map((id) => id.toLowerCase());
		if (ids.some((id) => declared.has(id))) {
			if (stored?.installed) for (const id of ids) missing.delete(id);
			continue;
		}
		await LunaPlugin.pluginStorage.del(name);
		trace.log(`Removed plugin ${name}, it is not declared in luna-settings.json`);
	}
	return missing;
}

/**
 * Find the missing plugins in the stores and install them.
 * Store entry names are matched first, package.json files are only fetched for ids that are still not found.
 */
async function installPlugins(missing: Map<string, string>, storeUrls: string[]): Promise<void> {
	const install = async (id: string, url: string, pkg?: LunaPluginStorage["package"]) => {
		missing.delete(id);
		const plugin = await LunaPlugin.fromStorage({ url, package: pkg });
		if (!plugin.installed) await plugin.install();
	};

	const failedStores: string[] = [];
	const stores = await Promise.all(
		storeUrls.map(async (storeUrl) => {
			try {
				const manifest = await ftch.json<{ plugins?: unknown }>(`${storeUrl}/store.json`);
				const files = Array.isArray(manifest.plugins) ? manifest.plugins.filter((file) => typeof file === "string") : [];
				return files.map((file) => ({ url: LunaPlugin.storePluginUrl(storeUrl, file).replace(/\.mjs$/, ""), entry: file.replace(/\.mjs$/, "") }));
			} catch (err) {
				failedStores.push(storeUrl);
				trace.err.withContext("Failed to fetch store", storeUrl)(err);
				return [];
			}
		}),
	);
	const entries = stores.flat();

	// By the name listed in the store
	for (const { url, entry } of entries) {
		const id = [entry, urlName(url)!].map((id) => id.toLowerCase()).find((id) => missing.has(id));
		if (id !== undefined) await install(id, url).catch(trace.msg.err.withContext("Failed to install plugin", url));
	}

	// By package name, only fetched when a name didn't match a store entry.
	// Skipped when the same ids weren't found in the same store entries (with the same stores failing) last start,
	// so a typo doesn't fetch every package.json on every start, while a start with a store down doesn't count for the next one
	const seedCache = ReactiveStore.getStore("@luna/seedSettings");
	const notFoundKey = () =>
		JSON.stringify({ ids: [...missing.keys()].sort(), entries: entries.map(({ url }) => url), failedStores: [...failedStores].sort() });
	if (missing.size !== 0 && (await seedCache.get<string>("notFound")) !== notFoundKey()) {
		const installedUrls = new Set(
			Object.values(LunaPlugin.plugins)
				.filter((plugin) => plugin.installed)
				.map((plugin) => plugin.url),
		);
		const packages = await Promise.all(
			entries
				.filter(({ url }) => !installedUrls.has(url))
				.map(({ url }) =>
					LunaPlugin.fetchPackage(url)
						.then((pkg) => ({ url, pkg }))
						.catch(() => undefined),
				),
		);
		for (const found of packages) {
			const id = found?.pkg.name?.toLowerCase();
			if (found === undefined || id === undefined || !missing.has(id)) continue;
			await install(id, found.url, found.pkg).catch(trace.msg.err.withContext("Failed to install plugin", found.url));
		}
	}

	if (missing.size === 0) await seedCache.del("notFound");
	else await seedCache.set("notFound", notFoundKey());
	if (missing.size !== 0) {
		trace.msg.err(
			`luna-settings.json: plugin(s) ${[...missing.values()].join(", ")} not found in any store. Use the name shown in the Plugin Store and declare its store.`,
		);
	}
}
