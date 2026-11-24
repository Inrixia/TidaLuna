import assert from "node:assert";
import { describe, it } from "node:test";

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
		assert.strictEqual(list.serial, 3);
		assert.deepStrictEqual(list.entries.get(SHA_A), { name: "A", hosts: ["api.a.com", "*.cdn.net/covers/*", "{setting:server}"] });
		// No hosts field: unknown, not "no network"
		assert.strictEqual(list.entries.has(SHA_B), false);
		assert.strictEqual(list.entries.size, 1);
	});

	it("refuses another key, another kind, another schema and a bad serial", () => {
		assert.throws(() => parse(doc(1, {}), other), /signature/);
		assert.throws(() => parse(doc(1, {}, { kind: "legacy" })), /kind "legacy"/);
		assert.throws(() => parse(doc(1, {}, { schema: 2 })), /schema/);
		assert.throws(() => parse(doc(0, {})), /serial/);
	});

	it("finds hosts only for the exact code under the plugin's own name", () => {
		const list = parse(doc(1, { [SHA_A]: { name: "A", hosts: ["api.a.com"] } }));
		assert.deepStrictEqual(lookupDerived(list, SHA_A, "A"), ["api.a.com"]);
		assert.strictEqual(lookupDerived(list, SHA_A, "Other"), undefined);
		assert.strictEqual(lookupDerived(list, SHA_B, "A"), undefined);
		assert.strictEqual(lookupDerived(undefined, SHA_A, "A"), undefined);
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
		assert.strictEqual(store.loaded(), false);
		await store.refresh();
		assert.deepStrictEqual(store.lookup(SHA_A, "A"), ["api.a.com"]);
		assert.ok(cache !== undefined);

		// A new start reads the cache; an older list replayed is refused and the cached one stays
		const restarted = createDerivedStore(deps);
		assert.strictEqual(restarted.loaded(), true);
		served = signed(doc(1, {}));
		await assert.rejects(restarted.refresh(), /rollback/);
		assert.deepStrictEqual(restarted.lookup(SHA_A, "A"), ["api.a.com"]);

		// A cache that fails its check is ignored
		cache = JSON.stringify({ list: Buffer.from("{}").toString("base64"), sig: "x" });
		const broken = createDerivedStore({ ...deps, fetchList: () => new Promise<never>(() => {}) });
		assert.strictEqual(broken.loaded(), false);
		assert.ok(logs.some((line) => line.includes("fails its check")));
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
		assert.ok(reads >= 3);
		assert.strictEqual(logs.filter((line) => line.includes("EBUSY")).length, 1);
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
		assert.ok(Date.now() - started < 1000);
		// Past the wait: no more waiting
		time = 100;
		const again = Date.now();
		await store.ready();
		assert.ok(Date.now() - again < 15);
	});
});
