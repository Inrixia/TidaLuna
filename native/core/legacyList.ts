// The old native format list (luna-registry `legacy.json`, docs/FORMAT.md there), the pure parts: signature, parsing,
// the "only shrinks" check and the lookup. Fetching and the cached copy are in legacyListMain.ts.
//
// A plugin's page bundle may register native code (the old format, without isolation: any page code can call it) only
// if its exact code is listed: every plugin every known store served at the cut-off. The list only ever shrinks: a new
// signed list is accepted only if its entries are a subset of the one accepted before, so an update, a new plugin or a
// replayed older list never gets on it.
import { createHash, createPublicKey, verify } from "crypto";

/**
 * TEST KEY: the public half of a key made only to test this client (the same one as the registry client's). It is NOT
 * the registry's signing key. The maintainer replaces it with keys/registry.pub of Inrixia/luna-registry (base64 of the
 * raw 32 ed25519 bytes). Anyone with the matching test private key can sign a list this build accepts: replace it
 * before this ships.
 */
export const legacyPublicKey = "mTYTC1NX88yDPzAuKmJoFXjM5cdJaCnsb5NXU8yAYRY=";
/** Where the registry's sign job publishes legacy.json and legacy.json.sig */
export const legacyListUrl = "https://raw.githubusercontent.com/Inrixia/luna-registry/signed/legacy.json";

export type LegacyListEntry = { store: string; id: string; sha256: string; natives: Record<string, string> };
export type LegacyList = { serial: number; cutoff: string; entries: LegacyListEntry[] };

const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
// ed25519 SubjectPublicKeyInfo header: the raw 32 key bytes follow it
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const entryKey = (e: LegacyListEntry) => `${e.store}\n${e.id}\n${e.sha256}`;
const sameEntry = (a: LegacyListEntry, b: LegacyListEntry) =>
	entryKey(a) === entryKey(b) && JSON.stringify(sortedNatives(a)) === JSON.stringify(sortedNatives(b));
const sortedNatives = (e: LegacyListEntry) => Object.entries(e.natives).sort(([a], [b]) => a.localeCompare(b));

/** Whether `sig` (base64, as in a .sig file) is an ed25519 signature of exactly `bytes` by `publicKey` (base64, raw) */
export const verifySignature = (bytes: Buffer, sig: string, publicKey: string = legacyPublicKey): boolean => {
	try {
		const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, "base64")]), format: "der", type: "spki" });
		return verify(null, bytes, key, Buffer.from(sig.trim(), "base64"));
	} catch {
		return false;
	}
};

/** A signed legacy.json, checked: throws unless the signature verifies and it is a legacy list */
export const parseLegacyList = (bytes: Buffer, sig: string, publicKey: string = legacyPublicKey): LegacyList => {
	if (!verifySignature(bytes, sig, publicKey)) throw new Error("legacy.json: the signature does not verify");
	const doc = JSON.parse(bytes.toString("utf8"));
	// The registry signs other files with the same key: one of them served as this list is refused
	if (doc?.kind !== "legacy") throw new Error(`legacy.json has kind ${JSON.stringify(doc?.kind)}, expected "legacy"`);
	if (doc.schema !== 1) throw new Error("legacy.json: unknown schema");
	if (!Number.isSafeInteger(doc.serial) || doc.serial < 1) throw new Error("legacy.json: no valid serial");
	if (typeof doc.cutoff !== "string") throw new Error("legacy.json: no cutoff");
	if (!Array.isArray(doc.entries)) throw new Error("legacy.json: no entries");
	const entries: LegacyListEntry[] = doc.entries.map((e: any, i: number) => {
		if (typeof e?.store !== "string" || typeof e.id !== "string" || typeof e.sha256 !== "string" || !HEX64.test(e.sha256))
			throw new Error(`legacy.json: entry ${i} is malformed`);
		const natives = e.natives !== null && typeof e.natives === "object" ? e.natives : {};
		return {
			store: e.store,
			id: e.id,
			sha256: e.sha256,
			natives: Object.fromEntries(Object.entries(natives).filter(([, h]) => typeof h === "string")),
		};
	});
	return { serial: doc.serial, cutoff: doc.cutoff, entries };
};

/**
 * Whether `next` may replace `current` (undefined: none accepted yet). Only a subset of the same cut-off with a serial
 * not lower: a list that grew, changed an entry or is older is refused.
 */
export const replacesList = (current: LegacyList | undefined, next: LegacyList): { ok: true } | { ok: false; reason: string } => {
	if (current === undefined) return { ok: true };
	if (next.serial < current.serial)
		return { ok: false, reason: `serial ${next.serial} is lower than ${current.serial}, already accepted (rollback)` };
	if (next.cutoff !== current.cutoff) return { ok: false, reason: `another cut-off: ${current.cutoff} -> ${next.cutoff}` };
	const before = new Map(current.entries.map((e) => [entryKey(e), e]));
	for (const e of next.entries) {
		const was = before.get(entryKey(e));
		if (was === undefined) return { ok: false, reason: `adds ${e.id} ${e.sha256.slice(0, 12)} (${e.store}): the list only shrinks` };
		if (!sameEntry(was, e)) return { ok: false, reason: `changes ${e.id} ${e.sha256.slice(0, 12)}` };
	}
	return { ok: true };
};

/** The served code, whatever url Luna imports it from: the `//# sourceURL=` line it adds names the url */
export const servedSha256 = (code: string) => sha256(code.replace(/\n\/\/# sourceURL=[^\n]*$/, ""));
/** The plugin's file name in its store, as in the list: the last part of its url */
export const pluginIdOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

/** Whether the list has exactly this plugin's code: its id and the sha256 of the served code */
export const listAllows = (list: LegacyList | undefined, url: string, code: string): boolean => {
	if (list === undefined) return false;
	const id = pluginIdOf(url);
	const sha = servedSha256(code);
	return list.entries.some((e) => e.sha256 === sha && e.id === id);
};

export type LegacyStoreDeps = {
	/** The cached copy written by `writeCache`, or undefined if there is none */
	readCache(): string | undefined;
	/** Replaces the cached copy at once (one file, written aside and renamed) */
	writeCache(text: string): void;
	/** legacy.json and its .sig from the registry */
	fetchList(): Promise<{ bytes: Buffer; sig: string }>;
	publicKey?: string;
	log?(message: string): void;
	/** How long the first check of a start with no cached copy waits for the first fetch */
	firstWaitMs?: number;
};

/**
 * The accepted list: the cached copy (its signature checked again on each start), replaced only by a fetched list
 * that may replace it (replacesList). The list bytes and their signature are cached together in one file, so a crash
 * mid-write can't leave a copy that fails its check (and with it the "only shrinks" rule).
 */
export const createLegacyStore = (deps: LegacyStoreDeps) => {
	let current: { list: LegacyList; bytes: Buffer } | undefined;
	/** `${id}\n${sha256}` of the current list */
	let allowed = new Set<string>();
	const use = (list: LegacyList, bytes: Buffer) => {
		current = { list, bytes };
		allowed = new Set(list.entries.map((e) => `${e.id}\n${e.sha256}`));
	};

	/**
	 * "unread": not read yet, or reading failed (a locked file): tried again on the next call. "none": no cached copy.
	 * "broken": a cached copy that fails its check. Only with "none" or "ok" can a fetched list be taken: without the
	 * accepted list, an older bigger one would pass as the first.
	 */
	let cache: "unread" | "none" | "ok" | "broken" = "unread";
	const loadCache = () => {
		if (cache !== "unread") return;
		let text: string | undefined;
		try {
			text = deps.readCache();
		} catch (err) {
			deps.log?.(`[Luna.core] The cached old native format list can't be read now: ${(err as Error)?.message ?? err}`);
			return;
		}
		if (text === undefined) return void (cache = "none");
		try {
			const cached = JSON.parse(text);
			const bytes = Buffer.from(String(cached?.list), "base64");
			use(parseLegacyList(bytes, String(cached?.sig), deps.publicKey), bytes);
			cache = "ok";
		} catch (err) {
			cache = "broken";
			deps.log?.(
				`[Luna.core] The cached old native format list fails its check: no old-format natives run until it is removed (${(err as Error)?.message ?? err})`,
			);
		}
	};

	/** Fetches the registry's list once; throws if it can't be used */
	const refresh = async () => {
		loadCache();
		if (cache === "unread") throw new Error("the cached list can't be read yet: not replaced");
		if (cache === "broken") throw new Error("the cached list fails its check: not replaced");
		const { bytes, sig } = await deps.fetchList();
		loadCache();
		const next = parseLegacyList(bytes, sig, deps.publicKey);
		const replaces = replacesList(current?.list, next);
		if (!replaces.ok) throw new Error(`refused: ${replaces.reason}`);
		// A removal under the same serial is still a removal: only the same bytes change nothing
		if (current !== undefined && current.bytes.equals(bytes)) return;
		deps.writeCache(JSON.stringify({ list: bytes.toString("base64"), sig: sig.trim() }));
		use(next, bytes);
		deps.log?.(`[Luna.core] Old native format list: serial ${next.serial}, ${next.entries.length} plugins`);
	};

	let first: Promise<void> | undefined;
	/** The first refresh (started once, again while the cache couldn't be read); never rejects */
	const start = () => {
		if (cache === "unread") first = undefined;
		return (first ??= refresh().catch((err) => deps.log?.(`[Luna.core] Old native format list not refreshed: ${(err as Error)?.message ?? err}`)));
	};
	let firstWait: Promise<void> | undefined;

	return {
		refresh,
		/** Whether the current list has this plugin's code (see RegistryDeps.legacyAllows) */
		allows: (id: string, servedSha256: string): boolean => {
			loadCache();
			void start();
			return allowed.has(`${id}\n${servedSha256}`);
		},
		/** Before a check: with no list yet, waits (once per start, at most firstWaitMs) for the first fetch */
		ready: async (): Promise<void> => {
			loadCache();
			const started = start();
			if (current !== undefined) return;
			firstWait ??= Promise.race([started, new Promise<void>((resolve) => setTimeout(resolve, deps.firstWaitMs ?? 10000).unref?.())]);
			await firstWait;
		},
		current: () => current?.list,
	};
};
