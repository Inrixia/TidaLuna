import { Signal } from "@inrixia/helpers";

import {
	acceptRegistryFile,
	base64ToBytes,
	defaultRegistryBase,
	registryBaseUrl,
	registryFileNames,
	registryLoadDecision,
	replacesInUse,
	revokedEntryFor,
	verifiedEntryFor,
	type AcceptResult,
	type LoadDecision,
	type RegistryFileName,
	type RevokedEntry,
	type RevokedFile,
	type VerifiedEntry,
	type VerifiedFile,
} from "./helpers/registry";
import { ReactiveStore } from "./ReactiveStore";
import { coreTrace, type Tracer } from "./trace";

/** A signed file as stored: its exact bytes (base64) and signature, so it is checked again when read back */
type StoredCopy = { bytes: string; signature: string; serial: number };

const bytesToBase64 = (bytes: Uint8Array): string => {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
};

export type RegistryFileStatus = {
	/** Where the copy in use came from: fetched and checked now, the last good copy, or none (plugins load, nothing is badged or revoked) */
	source: "fetched" | "cached" | "none";
	serial?: number;
	generated?: string;
	/** Why the last fetch was not used, if it wasn't */
	error?: string;
};

/**
 * The Luna plugin registry: signed lists of verified and revoked plugin builds, keyed by raw sha256 (see helpers/registry).
 *
 * Startup: index.ts awaits loadCached (the last good copies from IndexedDB, checked again) before user plugins load,
 * so a plugin revoked in a list this client already accepted never runs. refreshEvery() then fetches the lists without blocking plugin loading,
 * and again every hour; a newly accepted revoked.json unloads the plugins it revokes (LunaPlugin listens to `revoked`).
 * A missing, unreachable or badly signed registry never blocks plugins: the last good copy stays in use, or none.
 */
export class LunaRegistry {
	public static readonly trace: Tracer = coreTrace.withSource(".LunaRegistry").trace;
	/** The `baseUrl` override, and per file url (`<base>verified.json`, `<base>revoked.json`) its last good copy and the highest serial accepted (`<url>.serial`) */
	public static readonly storage: ReactiveStore = ReactiveStore.getStore("@luna/registry");

	public static readonly verified: Signal<VerifiedFile | undefined> = new Signal(undefined);
	public static readonly revoked: Signal<RevokedFile | undefined> = new Signal(undefined);
	public static readonly status: Signal<Record<RegistryFileName, RegistryFileStatus>> = new Signal({
		"verified.json": { source: "none" },
		"revoked.json": { source: "none" },
	});

	public static verifiedEntry(sha256: string | undefined, name: string): VerifiedEntry | undefined {
		return verifiedEntryFor(this.verified._, sha256, name);
	}
	public static revokedEntry(sha256: string | undefined): RevokedEntry | undefined {
		return revokedEntryFor(this.revoked._, sha256);
	}
	public static loadDecision(plugin: { url: string; rawSha256: string | undefined }): LoadDecision {
		return registryLoadDecision(plugin, this.revoked._);
	}

	/** The base url fetched from. Set `baseUrl` in this store (e.g. `http://127.0.0.1:3002/registry/`) to test a local registry, delete it to go back */
	public static async baseUrl(): Promise<string> {
		const override = await this.storage.get<string>("baseUrl");
		if (override === undefined) return registryBaseUrl(defaultRegistryBase);
		try {
			const base = registryBaseUrl(override);
			// Only a local test registry: an override to another host could serve old signed lists and hide newer revocations
			const { hostname } = new URL(base);
			if (hostname !== "127.0.0.1" && hostname !== "localhost") throw new Error(`only 127.0.0.1 or localhost: ${override}`);
			return base;
		} catch (err) {
			this.trace.warn(`Ignoring registry baseUrl override`, err);
			return registryBaseUrl(defaultRegistryBase);
		}
	}

	/** Copies and serials are kept per registry url: testing a local registry doesn't raise the serial the real one must reach */
	private static async highestSerial(fileUrl: string): Promise<number | undefined> {
		return this.storage.get<number>(`${fileUrl}.serial`);
	}

	private static setStatus(fileName: RegistryFileName, status: RegistryFileStatus) {
		this.status._ = { ...this.status._, [fileName]: status };
	}

	/** Put a checked file in use, unless the one in use has a higher serial (a slow loadCached finishing after refresh). Returns whether it did */
	private static use(fileName: RegistryFileName, file: VerifiedFile | RevokedFile, base: string): boolean {
		const signal = fileName === "verified.json" ? this.verified : this.revoked;
		// Serials only compare within one registry url (the override changed: the new registry's file is used)
		if (this.inUseFrom[fileName] === base) {
			if (!replacesInUse(signal._, file)) return false;
			// The same signed file fetched again (hourly): nothing changes, nothing re-renders or rechecks plugins
			if (signal._?.serial === file.serial && JSON.stringify(signal._.entries) === JSON.stringify(file.entries)) return true;
		}
		this.inUseFrom[fileName] = base;
		signal._ = <any>file;
		return true;
	}
	/** The registry url each file in use came from */
	private static readonly inUseFrom: Partial<Record<RegistryFileName, string>> = {};

	/** Put the last good copies in use. Called once at startup, before user plugins load */
	public static async loadCached(): Promise<void> {
		const base = await this.baseUrl();
		for (const fileName of registryFileNames) {
			try {
				const copy = await this.storage.get<StoredCopy>(`${base}${fileName}`);
				if (copy === undefined) continue;
				const result = await acceptRegistryFile(
					fileName,
					{ bytes: base64ToBytes(copy.bytes), signature: copy.signature },
					await this.highestSerial(`${base}${fileName}`),
				);
				if (!result.ok) {
					this.trace.warn(`Stored copy not used: ${result.reason}`);
					continue;
				}
				if (this.use(fileName, result.file, base))
					// A fetch that already failed keeps its error showing
					this.setStatus(fileName, {
						source: "cached",
						serial: result.file.serial,
						generated: result.file.generated,
						error: this.status._[fileName].error,
					});
			} catch (err) {
				this.trace.err.withContext("loadCached", fileName)(err);
			}
		}
	}

	private static async fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
		// no-store: always what the server has now, never a cached response
		const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
		if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
		return new Uint8Array(await res.arrayBuffer());
	}

	private static refreshing?: Promise<void>;
	/** Fetch both signed files and use each one that checks out. Never throws: failures keep the copy in use and show in `status` */
	public static refresh(): Promise<void> {
		return (this.refreshing ??= this.fetchAll().finally(() => (this.refreshing = undefined)));
	}
	private static async fetchAll(): Promise<void> {
		let base: string;
		try {
			base = await this.baseUrl();
		} catch (err) {
			return this.trace.err.withContext("refresh")(err);
		}
		await Promise.all(registryFileNames.map((fileName) => this.fetchFile(base, fileName)));
	}
	private static async fetchFile(base: string, fileName: RegistryFileName): Promise<void> {
		let result: AcceptResult<VerifiedFile | RevokedFile>;
		let bytes: Uint8Array<ArrayBuffer>;
		let signature: string;
		try {
			[bytes, signature] = await Promise.all([
				this.fetchBytes(`${base}${fileName}`),
				this.fetchBytes(`${base}${fileName}.sig`).then((sig) => new TextDecoder().decode(sig).trim()),
			]);
			result = await acceptRegistryFile(fileName, { bytes, signature }, await this.highestSerial(`${base}${fileName}`));
		} catch (err) {
			result = { ok: false, reason: `${fileName}: ${(<Error>err)?.message ?? err}` };
		}
		if (!result.ok) {
			// The copy in use stays, and so does where it came from
			this.trace.warn(`Not using the fetched ${fileName}, keeping the ${this.status._[fileName].source} copy: ${result.reason}`);
			this.setStatus(fileName, { ...this.status._[fileName], error: result.reason });
			return;
		}
		const { file } = result;
		try {
			// Serial first: if storing the copy fails, an older one can't be replayed
			const fileUrl = `${base}${fileName}`;
			if (((await this.highestSerial(fileUrl)) ?? -1) < file.serial) await this.storage.set(`${fileUrl}.serial`, file.serial);
			await this.storage.set<StoredCopy>(fileUrl, { bytes: bytesToBase64(bytes!), signature: signature!, serial: file.serial });
		} catch (err) {
			this.trace.err.withContext("Failed to store", fileName)(err);
		}
		if (this.use(fileName, file, base)) this.setStatus(fileName, { source: "fetched", serial: file.serial, generated: file.generated });
	}

	private static refreshTimer?: ReturnType<typeof setInterval>;
	/** Refresh now and then every `intervalMs` (default hourly), so a client left open picks up new revocations. Calling again restarts the timer */
	public static refreshEvery(intervalMs: number = 60 * 60 * 1000): Promise<void> {
		clearInterval(this.refreshTimer);
		this.refreshTimer = setInterval(() => void this.refresh(), intervalMs);
		return this.refresh();
	}
}
