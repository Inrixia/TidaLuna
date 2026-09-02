// Pure decision logic for the store list. registry.ts owns the reactive state and applies these.

export type RegistryStore = {
	name: string;
	repo: string;
	url: string;
	added?: string;
	status?: "active" | "removed";
	reason?: string;
};

export type BlocklistPattern = { pattern: string; reason: string };

export type StoreEntry = {
	url: string;
	/** Undefined for stores the user added themselves */
	entry?: RegistryStore;
	/** Whether the user can remove it outright rather than just hiding it */
	userAdded: boolean;
};

export type RegistryState = {
	registryStores: RegistryStore[];
	userUrls: string[];
	hiddenUrls: string[];
	/** The pre registry storeUrls key, only used while there is no registry */
	legacyUrls: string[];
	patterns: BlocklistPattern[];
};

/**
 * Users paste links to the store.json itself, everything downstream expects the base url
 */
export const normalizeStoreUrl = (url: string) => (url.endsWith("/store.json") ? url.slice(0, -11) : url);

const globToRegex = (pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`);

export const isBlocked = (patterns: BlocklistPattern[], url: string) => patterns.some(({ pattern }) => globToRegex(pattern).test(url));

const activeUrls = (stores: RegistryStore[]) => stores.filter((entry) => entry.status !== "removed").map((entry) => normalizeStoreUrl(entry.url));

export const tombstonedUrls = (stores: RegistryStore[]) =>
	stores.filter((entry) => entry.status === "removed").map((entry) => normalizeStoreUrl(entry.url));

export const knownUrls = (stores: RegistryStore[]) => stores.map((entry) => normalizeStoreUrl(entry.url));

/**
 * Registry stores minus the hidden ones, plus whatever the user added, minus anything blocked.
 * Falls back to the legacy list while no registry has been fetched yet, so the tab is never empty
 * for someone who is offline right after updating.
 */
export const mergeVisible = ({ registryStores, userUrls, hiddenUrls, legacyUrls, patterns }: RegistryState): StoreEntry[] => {
	const seen = new Set<string>();
	const out: StoreEntry[] = [];
	const push = (url: string, entry?: RegistryStore, userAdded = false) => {
		if (isBlocked(patterns, url) || seen.has(url)) return;
		seen.add(url);
		out.push({ url, entry, userAdded });
	};

	if (registryStores.length === 0) for (const url of legacyUrls) push(normalizeStoreUrl(url));
	for (const entry of registryStores) {
		const url = normalizeStoreUrl(entry.url);
		if (entry.status === "removed" || hiddenUrls.includes(url)) continue;
		push(url, entry);
	}
	for (const url of userUrls) push(url, undefined, true);
	return out;
};

/**
 * Which legacy urls belong in userStoreUrls. Anything the registry knows, tombstones included,
 * stays out, that is what finally drops the dead stores users have been carrying around.
 */
export const planMigration = ({ registryStores, userUrls, legacyUrls, patterns }: RegistryState): string[] => {
	const known = new Set(knownUrls(registryStores));
	const out: string[] = [];
	for (const rawUrl of legacyUrls) {
		const url = normalizeStoreUrl(rawUrl);
		if (known.has(url) || isBlocked(patterns, url) || userUrls.includes(url) || out.includes(url)) continue;
		out.push(url);
	}
	return out;
};

/**
 * User entries the registry has since tombstoned or blocked, and hidden entries the registry
 * no longer knows about so that list cannot grow forever.
 */
export const planCleanup = ({ registryStores, userUrls, hiddenUrls, patterns }: RegistryState) => {
	const dead = new Set(tombstonedUrls(registryStores));
	const known = new Set(knownUrls(registryStores));
	return {
		dropUser: userUrls.filter((url) => dead.has(url) || isBlocked(patterns, url)),
		dropHidden: hiddenUrls.filter((url) => !known.has(url)),
	};
};

/**
 * Adding a hidden registry store just unhides it, adding something already visible is a no op
 */
export const planAdd = (state: RegistryState, rawUrl: string): { unhide?: string; add?: string } | false => {
	const url = normalizeStoreUrl(rawUrl);
	if (isBlocked(state.patterns, url)) return false;
	if (state.hiddenUrls.includes(url)) return { unhide: url };
	if (mergeVisible(state).some((store) => store.url === url)) return false;
	return { add: url };
};

/**
 * Registry stores cannot be deleted, only hidden, otherwise they return on the next fetch
 */
export const planRemove = (state: RegistryState, rawUrl: string) => {
	const url = normalizeStoreUrl(rawUrl);
	const fromRegistry = activeUrls(state.registryStores).includes(url);
	return {
		dropUser: state.userUrls.includes(url) ? url : undefined,
		hide: fromRegistry && !state.hiddenUrls.includes(url) ? url : undefined,
	};
};
