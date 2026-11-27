import { describe, expect, it } from "vitest";

import { generateKeyPairSync, sign } from "node:crypto";

import { createDerivedStore, lookupDerived, parseVerifiedHosts } from "./derivedHosts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const other = generateKeyPairSync("ed25519").privateKey;

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const doc = (serial: number, entries: Record<string, object>, extra: object = {}) => ({
	kind: "verified",
	schema: 1,
	serial,
	entries,
	...extra,
});
const signed = (value: object, key = privateKey) => {
	const bytes = Buffer.from(JSON.stringify(value));
	return { bytes, sig: sign(null, bytes, key).toString("base64") };
};
const parse = (value: object, key = privateKey) => {
	const { bytes, sig } = signed(value, key);
	return parseVerifiedHosts(bytes, sig, pub);
};

describe("registry derived hosts", () => {
	it("takes a signed verified list and keeps only valid host entries", () => {
		const list = parse(
			doc(3, {
				[SHA_A]: { name: "A", hosts: ["api.a.com", "*", "*.com", "*.cdn.net/covers/*", "{setting:server}"] },
				[SHA_B]: { name: "B" },
				short: { name: "C", hosts: [] },
			}),
		);
		expect(list.serial).toBe(3);
		expect(list.entries.get(SHA_A)).toStrictEqual({ name: "A", hosts: ["api.a.com", "*.cdn.net/covers/*", "{setting:server}"] });
		// No hosts field: unknown, not "no network"
		expect(list.entries.has(SHA_B)).toBe(false);
		expect(list.entries.size).toBe(1);
	});

	it("refuses another key, another kind, another schema and a bad serial", () => {
		expect(() => parse(doc(1, {}), other)).toThrow(/signature/);
		expect(() => parse(doc(1, {}, { kind: "legacy" }))).toThrow(/kind "legacy"/);
		expect(() => parse(doc(1, {}, { schema: 2 }))).toThrow(/schema/);
		expect(() => parse(doc(0, {}))).toThrow(/serial/);
	});

	it("finds hosts only for the exact code under the plugin's own name", () => {
		const list = parse(doc(1, { [SHA_A]: { name: "A", hosts: ["api.a.com"] } }));
		expect(lookupDerived(list, SHA_A, "A")).toStrictEqual(["api.a.com"]);
		expect(lookupDerived(list, SHA_A, "Other")).toBe(undefined);
		expect(lookupDerived(list, SHA_B, "A")).toBe(undefined);
		expect(lookupDerived(undefined, SHA_A, "A")).toBe(undefined);
	});

	it("caches a fetched list, checks the cache, and refuses a lower serial", async () => {
		let cache: string | undefined;
		let served = signed(doc(2, { [SHA_A]: { name: "A", hosts: ["api.a.com"] } }));
		const logs: string[] = [];
		const deps = {
			readCache: () => cache,
			writeCache: (text: string) => void (cache = text),
			fetchList: async () => served,
			publicKey: pub,
			log: (message: string) => void logs.push(message),
		};
		const store = createDerivedStore(deps);
		expect(store.loaded()).toBe(false);
		await store.refresh();
		expect(store.lookup(SHA_A, "A")).toStrictEqual(["api.a.com"]);
		expect(cache !== undefined).toBeTruthy();

		// A new start reads the cache; an older list replayed is refused and the cached one stays
		const restarted = createDerivedStore(deps);
		expect(restarted.loaded()).toBe(true);
		served = signed(doc(1, {}));
		await expect(restarted.refresh()).rejects.toThrow(/rollback/);
		expect(restarted.lookup(SHA_A, "A")).toStrictEqual(["api.a.com"]);

		// A cache that fails its check is ignored
		cache = JSON.stringify({ list: Buffer.from("{}").toString("base64"), sig: "x" });
		const broken = createDerivedStore({ ...deps, fetchList: () => new Promise<never>(() => {}) });
		expect(broken.loaded()).toBe(false);
		expect(logs.some((line) => line.includes("fails its check"))).toBeTruthy();
		// …and with its serial unknown, no fetched list replaces it
		const brokenFetch = createDerivedStore({ ...deps, fetchList: async () => signed(doc(1, {})) });
		await expect(brokenFetch.refresh()).rejects.toThrow(/fails its check: not replaced/);

		// A cache that can't be read now (a locked file): no fetched list is taken until it is read
		const locked = createDerivedStore({
			...deps,
			readCache: () => {
				throw new Error("EBUSY");
			},
		});
		await expect(locked.refresh()).rejects.toThrow(/can't be read yet/);
		expect(locked.loaded()).toBe(false);
	});

	it("logs a cache it can't read once per reason, and tries again on each use", async () => {
		const logs: string[] = [];
		let reads = 0;
		const store = createDerivedStore({
			readCache: () => {
				reads++;
				throw new Error("EBUSY");
			},
			writeCache: () => {},
			fetchList: () => new Promise<never>(() => {}),
			publicKey: pub,
			log: (message: string) => void logs.push(message),
		});
		for (let i = 0; i < 3; i++) store.lookup(SHA_A, "A");
		expect(reads >= 3).toBeTruthy();
		expect(logs.filter((line) => line.includes("EBUSY")).length).toBe(1);
	});

	it("waits at most firstWaitMs for a first list before a confirmation", async () => {
		let time = 0;
		const store = createDerivedStore({
			readCache: () => undefined,
			writeCache: () => {},
			fetchList: () => new Promise<never>(() => {}),
			publicKey: pub,
			firstWaitMs: 20,
			now: () => time,
		});
		const started = Date.now();
		await store.ready();
		expect(Date.now() - started < 1000).toBeTruthy();
		// Past the wait: no more waiting
		time = 100;
		const again = Date.now();
		await store.ready();
		expect(Date.now() - again < 15).toBeTruthy();
	});
});
