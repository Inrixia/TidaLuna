import { ftch, ReactiveStore } from "@luna/core";

const RAW = "https://raw.githubusercontent.com/Inrixia/TidaLuna/master/store";
export const REGISTRY_URL = `${RAW}/registry.json`;
export const STORES_URL = `${RAW}/stores.json`;
export const BLOCKLIST_URL = `${RAW}/blocklist.json`;

// The settings page unmounts tabs on switch, without this every visit refetches
const REFRESH_INTERVAL = 15 * 60 * 1000;
// Metrics go stale silently if the generator stops running, so drop them rather than show a wrong number
const MAX_METRIC_AGE = 7 * 24 * 60 * 60 * 1000;

export type RegistryStore = {
	name: string;
	repo: string;
	url: string;
	added?: string;
	status?: "active" | "removed";
	reason?: string;
	health?: "ok" | "archived" | "unreachable";
	stars?: number;
	downloads?: Record<string, number>;
};
type BlocklistPattern = { pattern: string; reason: string };
type Registry = { version: number; generatedAt?: string; stores: RegistryStore[] };
type Blocklist = { version: number; patterns: BlocklistPattern[] };

export type StoreEntry = {
	url: string;
	/** Undefined for a store the user added themselves */
	entry?: RegistryStore;
	/** User stores can be deleted outright, registry defaults can only be hidden */
	userAdded: boolean;
};

const pluginStores = ReactiveStore.getStore("@luna/pluginStores");

// The registry as last seen. Persisted, so it doubles as the offline fallback
export const registryStores = await pluginStores.getReactive<Registry>("registry", { version: 1, stores: [] });
const blocklist = await pluginStores.getReactive<Blocklist>("blocklist", { version: 1, patterns: [] });
// Only ever what the user added themselves, never a registry default
export const userStoreUrls = await pluginStores.getReactive<string[]>("userStoreUrls", []);
// Registry defaults the user removed, or they would come back on every start
export const hiddenStoreUrls = await pluginStores.getReactive<string[]>("hiddenStoreUrls", []);
// The pre registry client kept one flat list. Read once, used only to keep the tab populated
// until a registry lands, then migrated into userStoreUrls and deleted (migrateLegacy).
const legacyStoreUrls = (await pluginStores.get<string[]>("storeUrls")) ?? [];

// Users paste the store.json link itself, everything downstream wants the base url
export const normalizeStoreUrl = (url: string) => (url.endsWith("/store.json") ? url.slice(0, -11) : url);

const globToRegex = (pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`);
export const metricsAreFresh = () => {
	if (registryStores.generatedAt === undefined) return false;
	const age = Date.now() - Date.parse(registryStores.generatedAt);
	return Number.isFinite(age) && age >= 0 && age < MAX_METRIC_AGE;
};

export const isBlocked = (url: string) => blocklist.patterns.some(({ pattern }) => globToRegex(pattern).test(url));

/**
 * Registry stores minus the hidden ones, plus whatever the user added, minus anything blocked.
 * While no registry has ever been fetched the legacy list keeps the tab populated, so someone
 * offline right after updating still sees stores.
 */
export const visibleStores = (): StoreEntry[] => {
	const out: StoreEntry[] = [];
	const seen = new Set<string>();
	const push = (url: string, entry?: RegistryStore, userAdded = false) => {
		if (seen.has(url) || isBlocked(url)) return;
		seen.add(url);
		out.push({ url, entry, userAdded });
	};
	if (registryStores.stores.length === 0) for (const url of legacyStoreUrls) push(normalizeStoreUrl(url));
	for (const entry of registryStores.stores) {
		const url = normalizeStoreUrl(entry.url);
		if (entry.status !== "removed" && !hiddenStoreUrls.includes(url)) push(url, entry);
	}
	for (const url of userStoreUrls) push(url, undefined, true);
	return out;
};

export const addToStores = (rawUrl: string) => {
	const url = normalizeStoreUrl(rawUrl);
	if (isBlocked(url)) return false;
	// A hidden registry default is just unhidden
	const hidden = hiddenStoreUrls.indexOf(url);
	if (hidden > -1) {
		hiddenStoreUrls.splice(hidden, 1);
		return true;
	}
	if (visibleStores().some((store) => store.url === url)) return false;
	userStoreUrls.push(url);
	return true;
};

export const removeStore = (rawUrl: string) => {
	const url = normalizeStoreUrl(rawUrl);
	const user = userStoreUrls.indexOf(url);
	if (user > -1) {
		userStoreUrls.splice(user, 1);
		return;
	}
	// A registry default cannot be deleted, only hidden, or it returns on the next fetch
	const isDefault = registryStores.stores.some((e) => e.status !== "removed" && normalizeStoreUrl(e.url) === url);
	if (isDefault && !hiddenStoreUrls.includes(url)) hiddenStoreUrls.push(url);
};

// Move the old flat storeUrls list into userStoreUrls, dropping everything the registry now owns.
// Runs once a registry has landed, otherwise a failed fetch would turn every default into a user store.
const migrateLegacy = async () => {
	if ((await pluginStores.get<boolean>("registryMigration")) === true) return;
	const known = new Set(registryStores.stores.map((e) => normalizeStoreUrl(e.url)));
	for (const raw of legacyStoreUrls) {
		const url = normalizeStoreUrl(raw);
		if (!known.has(url) && !isBlocked(url) && !userStoreUrls.includes(url)) userStoreUrls.push(url);
	}
	await pluginStores.set("registryMigration", true);
	await pluginStores.del("storeUrls");
};

const isRegistry = (data: unknown): data is Registry =>
	typeof data === "object" && data !== null && Array.isArray((<Registry>data).stores) && (<Registry>data).version === 1;

const fetchRegistry = async () => {
	// Blocklist is a kill switch, a failure here must not stop the registry from loading
	await ftch
		.json<Blocklist>(BLOCKLIST_URL)
		.then((data) => {
			if (data?.version === 1 && Array.isArray(data.patterns)) return pluginStores.set("blocklist", data);
		})
		.catch(() => {});

	// registry.json carries the metrics, stores.json is the same shape without them
	let fetched: Registry | undefined;
	for (const url of [REGISTRY_URL, STORES_URL]) {
		try {
			const data = await ftch.json<Registry>(url);
			if (isRegistry(data)) {
				fetched = data;
				break;
			}
		} catch {}
	}
	// Nothing reachable, keep whatever the last fetch left behind
	if (fetched !== undefined) await pluginStores.set("registry", fetched);
	if (registryStores.stores.length === 0) return false;

	await migrateLegacy();
	return fetched !== undefined;
};

let lastFetch = 0;
let inFlight: Promise<boolean> | undefined;
// At most once per REFRESH_INTERVAL unless forced, and never twice at the same time
export const refreshRegistry = (force = false) => {
	if (inFlight !== undefined) return inFlight;
	if (!force && lastFetch !== 0 && Date.now() - lastFetch < REFRESH_INTERVAL) return Promise.resolve(false);
	inFlight = fetchRegistry().finally(() => {
		lastFetch = Date.now();
		inFlight = undefined;
	});
	return inFlight;
};
