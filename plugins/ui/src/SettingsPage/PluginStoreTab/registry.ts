import { ftch, ReactiveStore } from "@luna/core";

import {
	isBlocked as isBlockedBy,
	mergeVisible,
	normalizeStoreUrl,
	planAdd,
	planCleanup,
	planMigration,
	planRemove,
	type BlocklistPattern,
	type RegistryState,
	type RegistryStore,
	type StoreEntry,
} from "./registry.logic";

export { normalizeStoreUrl, type RegistryStore, type StoreEntry };

const RAW = "https://raw.githubusercontent.com/Inrixia/TidaLuna/master/store";
export const STORES_URL = `${RAW}/stores.json`;
export const BLOCKLIST_URL = `${RAW}/blocklist.json`;

// The settings page unmounts tabs on switch, without this every visit refetches
const REFRESH_INTERVAL = 15 * 60 * 1000;

type Registry = { version: number; stores: RegistryStore[] };
type Blocklist = { version: number; patterns: BlocklistPattern[] };

const pluginStores = ReactiveStore.getStore("@luna/pluginStores");

// The registry as last seen. Persisted, so it doubles as the offline fallback
export const registryStores = await pluginStores.getReactive<Registry>("registry", { version: 1, stores: [] });
const blocklist = await pluginStores.getReactive<Blocklist>("blocklist", { version: 1, patterns: [] });
// Only ever what the user added themselves, never a registry default
export const userStoreUrls = await pluginStores.getReactive<string[]>("userStoreUrls", []);
// Registry stores the user removed. Without this they come back on every start
export const hiddenStoreUrls = await pluginStores.getReactive<string[]>("hiddenStoreUrls", []);
// What the pre registry client persisted. Read once and only used to keep the tab populated
// until a registry lands, it is deliberately never merged into userStoreUrls by itself
const legacyStoreUrls = (await pluginStores.get<string[]>("storeUrls")) ?? [];

const state = (): RegistryState => ({
	registryStores: registryStores.stores,
	userUrls: userStoreUrls,
	hiddenUrls: hiddenStoreUrls,
	legacyUrls: legacyStoreUrls,
	patterns: blocklist.patterns,
});

export const isBlocked = (url: string) => isBlockedBy(blocklist.patterns, url);
export const visibleStores = () => mergeVisible(state());

export const addToStores = (rawUrl: string) => {
	const plan = planAdd(state(), rawUrl);
	if (plan === false) return false;
	if (plan.unhide !== undefined) hiddenStoreUrls.splice(hiddenStoreUrls.indexOf(plan.unhide), 1);
	if (plan.add !== undefined) userStoreUrls.push(plan.add);
	return true;
};

export const removeStore = (rawUrl: string) => {
	const plan = planRemove(state(), rawUrl);
	if (plan.dropUser !== undefined) userStoreUrls.splice(userStoreUrls.indexOf(plan.dropUser), 1);
	if (plan.hide !== undefined) hiddenStoreUrls.push(plan.hide);
};

const splice = (list: string[], urls: string[]) => {
	for (const url of urls) {
		const index = list.indexOf(url);
		if (index > -1) list.splice(index, 1);
	}
};

/**
 * Move the old combined storeUrls list into userStoreUrls, dropping everything the registry now owns.
 * Only runs once we have a registry, otherwise a failed fetch would turn every default into a user store.
 */
const migrateLegacyStoreUrls = async () => {
	if ((await pluginStores.get<boolean>("registryMigration")) === true) return;
	for (const url of planMigration(state())) userStoreUrls.push(url);
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

	let fetched: Registry | undefined;
	try {
		const data = await ftch.json<Registry>(STORES_URL);
		if (isRegistry(data)) fetched = data;
	} catch {}
	// Nothing reachable, keep whatever the last fetch left behind
	if (fetched !== undefined) await pluginStores.set("registry", fetched);
	if (registryStores.stores.length === 0) return false;

	await migrateLegacyStoreUrls();
	const cleanup = planCleanup(state());
	splice(userStoreUrls, cleanup.dropUser);
	splice(hiddenStoreUrls, cleanup.dropHidden);
	return fetched !== undefined;
};

let lastFetch = 0;
let inFlight: Promise<boolean> | undefined;

/**
 * Fetches at most once per REFRESH_INTERVAL unless forced, and never twice at the same time
 */
export const refreshRegistry = (force = false) => {
	if (inFlight !== undefined) return inFlight;
	if (!force && lastFetch !== 0 && Date.now() - lastFetch < REFRESH_INTERVAL) return Promise.resolve(false);
	inFlight = fetchRegistry().finally(() => {
		lastFetch = Date.now();
		inFlight = undefined;
	});
	return inFlight;
};
