// The hosts luna-registry read from a plugin's code (option C of the network design): for a plugin whose package.json
// lists no `hosts`, Luna takes the list the registry derived for that exact code, and the user confirms it like declared
// hosts (registry.ts). The pure parts: the signed `verified.json` (luna-registry docs/FORMAT.md), the rollback check and
// the lookup. Fetching and the cached copy are in derivedHostsMain.ts.
//
// The old native format list (legacyList.ts) carries the same derived `hosts` for the plugins it lists: those run
// without host prompts until they update (registry.ts legacyNet).
import { legacyPublicKey, verifySignature } from "./legacyList";
import { declaredHosts } from "./hosts";

/** Where the registry's sign job publishes verified.json and verified.json.sig */
export const verifiedListUrl = "https://raw.githubusercontent.com/Inrixia/luna-registry/signed/verified.json";

export type DerivedEntry = { name: string; hosts: string[] };
export type VerifiedHosts = { serial: number; entries: Map<string, DerivedEntry> };

const HEX64 = /^[0-9a-f]{64}$/;

/** A signed verified.json, checked: throws unless the signature verifies and it is the verified list */
export const parseVerifiedHosts = (bytes: Buffer, sig: string, publicKey: string = legacyPublicKey): VerifiedHosts => {
	if (!verifySignature(bytes, sig, publicKey)) throw new Error("verified.json: the signature does not verify");
	const doc = JSON.parse(bytes.toString("utf8"));
	// The registry signs other files with the same key: one of them served as this one is refused
	if (doc?.kind !== "verified") throw new Error(`verified.json has kind ${JSON.stringify(doc?.kind)}, expected "verified"`);
	if (doc.schema !== 1) throw new Error("verified.json: unknown schema");
	if (!Number.isSafeInteger(doc.serial) || doc.serial < 1) throw new Error("verified.json: no valid serial");
	if (doc.entries === null || typeof doc.entries !== "object") throw new Error("verified.json: no entries");
	const entries = new Map<string, DerivedEntry>();
	for (const [sha, entry] of Object.entries(doc.entries as Record<string, any>)) {
		if (!HEX64.test(sha) || typeof entry?.name !== "string") continue;
		// An entry from before the registry derived hosts has none: unknown, not "no network"
		const hosts = declaredHosts(entry.hosts);
		if (hosts === undefined) continue;
		entries.set(sha, { name: entry.name, hosts: hosts.hosts });
	}
	return { serial: doc.serial, entries };
};

/** The derived hosts for this exact code, if the list has it under this plugin's name */
export const lookupDerived = (list: VerifiedHosts | undefined, servedSha256: string, name: string): string[] | undefined => {
	const entry = list?.entries.get(servedSha256);
	return entry !== undefined && entry.name === name ? entry.hosts : undefined;
};

export type DerivedStoreDeps = {
	readCache(): string | undefined;
	writeCache(text: string): void;
	fetchList(): Promise<{ bytes: Buffer; sig: string }>;
	publicKey?: string;
	log?(message: string): void;
	firstWaitMs?: number;
	now?(): number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * The accepted verified list: the cached copy (checked again on each start), replaced by a fetched one that verifies and
 * whose serial isn't lower (an older signed list replayed would hide newer entries, not add any). Without a list, plugins
 * without `hosts` get no derived list: every host they use is asked at runtime.
 */
export const createDerivedStore = (deps: DerivedStoreDeps) => {
	let current: { list: VerifiedHosts; bytes: Buffer; sig: string } | undefined;
	let cacheRead = false;
	/** The last reason the cache couldn't be read: it is tried again on each use, and logged once per reason */
	let cacheError: string | undefined;
	const loadCache = () => {
		if (cacheRead) return;
		let text: string | undefined;
		try {
			text = deps.readCache();
		} catch (err) {
			const reason = String((err as Error)?.message ?? err);
			if (reason !== cacheError) deps.log?.(`[Luna.core] The cached registry list can't be read now: ${reason}`);
			cacheError = reason;
			return;
		}
		cacheRead = true;
		if (text === undefined) return;
		try {
			const cached = JSON.parse(text);
			const bytes = Buffer.from(String(cached?.list), "base64");
			current = { list: parseVerifiedHosts(bytes, String(cached?.sig), deps.publicKey), bytes, sig: String(cached?.sig) };
		} catch (err) {
			deps.log?.(`[Luna.core] The cached registry list fails its check, ignored: ${(err as Error)?.message ?? err}`);
		}
	};

	const refresh = async () => {
		loadCache();
		const { bytes, sig } = await deps.fetchList();
		const next = parseVerifiedHosts(bytes, sig, deps.publicKey);
		if (current !== undefined && next.serial < current.list.serial)
			throw new Error(`refused: serial ${next.serial} is lower than ${current.list.serial}, already accepted (rollback)`);
		if (current?.bytes.equals(bytes)) return;
		current = { list: next, bytes, sig };
		try {
			deps.writeCache(JSON.stringify({ list: bytes.toString("base64"), sig: sig.trim() }));
		} catch (err) {
			deps.log?.(`[Luna.core] The registry list can't be cached now: ${(err as Error)?.message ?? err}`);
		}
		deps.log?.(`[Luna.core] Registry list: serial ${next.serial}, ${next.entries.size} plugins with derived hosts`);
	};

	let first: Promise<void> | undefined;
	const start = () =>
		(first ??= refresh().catch((err) => {
			deps.log?.(`[Luna.core] Registry list not refreshed: ${(err as Error)?.message ?? err}`);
			// The next lookup tries again
			setTimeout(() => (first = undefined), 60_000).unref?.();
		}));
	const now = deps.now ?? Date.now;
	let waitUntil: number | undefined;

	return {
		refresh,
		refreshNow: (): Promise<void> => {
			first = undefined;
			return start();
		},
		lookup: (servedSha256: string, name: string): string[] | undefined => {
			loadCache();
			void start();
			return lookupDerived(current?.list, servedSha256, name);
		},
		loaded: () => {
			loadCache();
			return current !== undefined;
		},
		/** Before a confirmation: with no list yet, waits for the first fetch, at most firstWaitMs after the first call */
		ready: async (): Promise<void> => {
			loadCache();
			if (current !== undefined) return;
			waitUntil ??= now() + (deps.firstWaitMs ?? 10000);
			const left = waitUntil - now();
			if (left > 0) await Promise.race([start(), sleep(left)]);
		},
	};
};
