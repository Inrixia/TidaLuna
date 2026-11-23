/**
 * Client side of the Luna plugin registry (https://github.com/Inrixia/luna-registry), the pure parts: signature check, parsing,
 * rollback check and lookups. State (fetching, the last good copy) is in render/src/LunaRegistry.ts.
 * The contract is the registry's docs/FORMAT.md.
 *
 * The registry keys every entry by the **raw sha256** of a plugin: the sha256 of the built `<name>.mjs` as served, see rawSha256.
 * That is not PluginPackage.codeSha256, which hashes the text Luna imports (it depends on the plugin's url).
 */
import { isCoreUrl, sha256Hex } from "./pluginUpdates";

/**
 * TEST KEY: the public half of a key made only to test this client. It is NOT the registry's signing key.
 * The maintainer replaces it with the contents of keys/registry.pub in Inrixia/luna-registry (base64 of the raw 32 ed25519 bytes).
 * Anyone with the matching test private key can sign a registry this build accepts: replace it before this ships.
 */
export const registryPublicKey = "mTYTC1NX88yDPzAuKmJoFXjM5cdJaCnsb5NXU8yAYRY=";

/** Where the sign job publishes verified.json, revoked.json and their .sig files */
export const defaultRegistryBase = "https://raw.githubusercontent.com/Inrixia/luna-registry/signed/";

export const registryFileNames = ["verified.json", "revoked.json"] as const;
export type RegistryFileName = (typeof registryFileNames)[number];

export type VerifiedEntry = {
	id: string;
	/** The plugin's name: the badge is shown only when it equals the plugin's name */
	name: string;
	repo?: string;
	commit?: string;
	/** Where in the repo the plugin is, its build command and output folder (as the registry built it) */
	path?: string;
	build?: string;
	out?: string;
	natives?: Record<string, string>;
	capabilities?: string[];
	report?: string;
	verifiedAt?: string;
	sig?: string;
};
export type RevokedEntry = {
	id?: string;
	reason: string;
	report?: string;
	revokedAt?: string;
	sig?: string;
};
export type RegistryFile<Entry> = {
	schema: 1;
	serial: number;
	generated?: string;
	/** Keyed by raw sha256 (lowercase hex). Has no prototype, so a key like `__proto__` or `constructor` is only ever an entry */
	entries: Record<string, Entry>;
};
export type VerifiedFile = RegistryFile<VerifiedEntry>;
export type RevokedFile = RegistryFile<RevokedEntry>;

const hex64 = /^[0-9a-f]{64}$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
/** Links are shown to the user as clickable: only http(s) */
const optionalLink = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	try {
		const { protocol } = new URL(value);
		return protocol === "https:" || protocol === "http:" ? value : undefined;
	} catch {
		return undefined;
	}
};

const toVerifiedEntry = (value: unknown): VerifiedEntry | undefined => {
	if (!isObject(value) || typeof value.name !== "string") return undefined;
	return {
		id: optionalString(value.id) ?? "",
		name: value.name,
		repo: optionalString(value.repo),
		commit: optionalString(value.commit),
		path: optionalString(value.path),
		build: optionalString(value.build),
		out: optionalString(value.out),
		natives: isObject(value.natives) ? (value.natives as Record<string, string>) : undefined,
		capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter((cap): cap is string => typeof cap === "string") : undefined,
		report: optionalLink(value.report),
		verifiedAt: optionalString(value.verifiedAt),
		sig: optionalString(value.sig),
	};
};
/** Any listed sha256 is revoked, whatever else its entry holds: a malformed entry still revokes */
const toRevokedEntry = (value: unknown): RevokedEntry => {
	const entry = isObject(value) ? value : {};
	return {
		id: optionalString(entry.id),
		reason: optionalString(entry.reason) ?? "No reason given",
		report: optionalLink(entry.report),
		revokedAt: optionalString(entry.revokedAt),
		sig: optionalString(entry.sig),
	};
};

/**
 * Parse a signed file's text. Throws if it is not a registry file (schema 1, a non-negative integer serial, an entries object).
 * Keys that are not a lowercase hex sha256 are dropped, so are verified entries without a name.
 */
export function parseRegistryFile(fileName: "verified.json", text: string): VerifiedFile;
export function parseRegistryFile(fileName: "revoked.json", text: string): RevokedFile;
export function parseRegistryFile(fileName: RegistryFileName, text: string): VerifiedFile | RevokedFile;
export function parseRegistryFile(fileName: RegistryFileName, text: string): VerifiedFile | RevokedFile {
	const json: unknown = JSON.parse(text);
	if (!isObject(json)) throw new Error(`${fileName} is not an object`);
	if (json.schema !== 1) throw new Error(`${fileName} has schema ${String(json.schema)}, expected 1`);
	if (typeof json.serial !== "number" || !Number.isSafeInteger(json.serial) || json.serial < 0)
		throw new Error(`${fileName} has no valid serial`);
	if (!isObject(json.entries)) throw new Error(`${fileName} has no entries`);
	const entries: Record<string, any> = Object.create(null);
	for (const [sha256, value] of Object.entries(json.entries)) {
		if (!hex64.test(sha256)) continue;
		const entry = fileName === "verified.json" ? toVerifiedEntry(value) : toRevokedEntry(value);
		if (entry !== undefined) entries[sha256] = entry;
	}
	return { schema: 1, serial: json.serial, generated: optionalString(json.generated), entries };
}

export const base64ToBytes = (base64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(base64.trim()), (char) => char.charCodeAt(0));

/**
 * Whether `signature` (base64, as in a `.sig` file) is a valid ed25519 signature of exactly `bytes` by `publicKey` (base64 of the raw 32 bytes).
 * Web Crypto: Chromium (Electron) and Node both have Ed25519, so the same code runs in TIDAL and in the tests.
 */
export const verifySignature = async (bytes: BufferSource, signature: string, publicKey: string = registryPublicKey): Promise<boolean> => {
	try {
		const key = await crypto.subtle.importKey("raw", base64ToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify({ name: "Ed25519" }, key, base64ToBytes(signature), bytes);
	} catch {
		// A malformed key or signature (wrong length, not base64) is not a valid signature
		return false;
	}
};

export type AcceptResult<File> = { ok: true; file: File } | { ok: false; reason: string };

/**
 * Check a fetched (or stored) signed file: its signature over the exact bytes, its content, and that its serial is not lower than
 * `highestSerial`, the highest serial already accepted for this file (an older signed file could be replayed to hide a newer revocation).
 * The same serial is accepted: it is the same file fetched again.
 */
export async function acceptRegistryFile(
	fileName: "verified.json",
	file: { bytes: Uint8Array<ArrayBuffer>; signature: string },
	highestSerial?: number,
	publicKey?: string,
): Promise<AcceptResult<VerifiedFile>>;
export async function acceptRegistryFile(
	fileName: "revoked.json",
	file: { bytes: Uint8Array<ArrayBuffer>; signature: string },
	highestSerial?: number,
	publicKey?: string,
): Promise<AcceptResult<RevokedFile>>;
export async function acceptRegistryFile(
	fileName: RegistryFileName,
	file: { bytes: Uint8Array<ArrayBuffer>; signature: string },
	highestSerial?: number,
	publicKey?: string,
): Promise<AcceptResult<VerifiedFile | RevokedFile>>;
export async function acceptRegistryFile(
	fileName: RegistryFileName,
	{ bytes, signature }: { bytes: Uint8Array<ArrayBuffer>; signature: string },
	highestSerial?: number,
	publicKey: string = registryPublicKey,
): Promise<AcceptResult<VerifiedFile | RevokedFile>> {
	if (!(await verifySignature(bytes, signature, publicKey))) return { ok: false, reason: `${fileName}: the signature does not verify` };
	let parsed: VerifiedFile | RevokedFile;
	try {
		parsed = parseRegistryFile(fileName, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (err) {
		return { ok: false, reason: `${fileName}: ${(<Error>err)?.message ?? err}` };
	}
	if (highestSerial !== undefined && parsed.serial < highestSerial)
		return { ok: false, reason: `${fileName}: serial ${parsed.serial} is lower than ${highestSerial}, already accepted (rollback)` };
	return { ok: true, file: parsed };
}

/** Whether an accepted file replaces the one in use: not when the one in use has a higher serial (a stored copy read after a newer fetch) */
export const replacesInUse = (inUse: { serial: number } | undefined, file: { serial: number }): boolean => inUse === undefined || file.serial >= inUse.serial;
/**
 * The code a plugin's `.mjs` served, from the code Luna stores for it (LunaPlugin.fetchPackage appends `\n//# sourceURL=<url>.mjs`).
 * The suffix is matched by shape, not by url, so code stored before the plugin's url moved (LunaPlugin.migrateBaseUrl) still matches.
 */
export const rawCodeOf = (storedCode: string): string => storedCode.replace(/\n\/\/# sourceURL=[^\n]*$/, "");

/**
 * The raw sha256 of a plugin's code, the key the registry uses (PluginPackage.rawSha256): sha256 of the served `.mjs` as UTF-8.
 * esbuild writes UTF-8 without a BOM, so for a registry build this is the sha256 of the file's bytes, as the registry computes it.
 * Computed from the text Luna got (fetch decodes UTF-8 and drops a BOM), so it is the hash of what runs:
 * a BOM in front of revoked code does not change it.
 */
export const rawSha256 = (storedCode: string): Promise<string> => sha256Hex(rawCodeOf(storedCode));

/** The verified entry for this code, only if the entry names this plugin (so a verified build can't lend its badge to another name) */
export const verifiedEntryFor = (verified: VerifiedFile | undefined, sha256: string | undefined, name: string): VerifiedEntry | undefined => {
	if (verified === undefined || sha256 === undefined || !Object.hasOwn(verified.entries, sha256)) return undefined;
	const entry = verified.entries[sha256];
	return entry.name === name ? entry : undefined;
};

/** The revocation of this code, if any */
export const revokedEntryFor = (revoked: RevokedFile | undefined, sha256: string | undefined): RevokedEntry | undefined => {
	if (revoked === undefined || sha256 === undefined || !Object.hasOwn(revoked.entries, sha256)) return undefined;
	return revoked.entries[sha256];
};

export type LoadDecision = { load: true } | { load: false; revoked: RevokedEntry };
/** Whether a plugin's code may run: not if its raw sha256 is revoked. Dev plugins are checked too: revocation is about the exact code, not where it comes from */
export const registryLoadDecision = (plugin: { url: string; rawSha256: string | undefined }, revoked: RevokedFile | undefined): LoadDecision => {
	if (isCoreUrl(plugin.url)) return { load: true };
	const entry = revokedEntryFor(revoked, plugin.rawSha256);
	return entry === undefined ? { load: true } : { load: false, revoked: entry };
};

/**
 * Enabled plugins whose code has no verified entry, for "N unverified plugins enabled".
 * All plugins share one JS realm, so one unverified plugin can patch verified ones: the badge means little while this is not 0.
 * Counts dev plugins (127.0.0.1): their code is not verified either. Leaves out Luna's own plugins and revoked plugins (they don't run).
 */
export const unverifiedPlugins = <P extends { url: string; name: string; installed: boolean; enabled: boolean; rawSha256: string | undefined }>(
	plugins: P[],
	verified: VerifiedFile | undefined,
	revoked: RevokedFile | undefined,
): P[] =>
	plugins.filter(
		(plugin) =>
			plugin.installed &&
			plugin.enabled &&
			!isCoreUrl(plugin.url) &&
			registryLoadDecision(plugin, revoked).load &&
			verifiedEntryFor(verified, plugin.rawSha256, plugin.name) === undefined,
	);

/**
 * The registry base url to fetch from: https, or http on this machine (127.0.0.1, localhost) to test a local registry.
 * Ends with `/`. Throws for anything else.
 */
export const registryBaseUrl = (base: string = defaultRegistryBase): string => {
	const url = new URL(base);
	const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
	if (url.protocol !== "https:" && !local) throw new Error(`Registry url must be https (or http on 127.0.0.1/localhost): ${base}`);
	return url.href.endsWith("/") ? url.href : `${url.href}/`;
};
