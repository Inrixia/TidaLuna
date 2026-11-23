import assert from "node:assert";
import { describe, it } from "node:test";

import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { createLegacyStore, listAllows, parseLegacyList, replacesList, servedSha256, type LegacyList } from "./legacyList";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
// The raw 32 key bytes, as keys/registry.pub holds them
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const other = generateKeyPairSync("ed25519").privateKey;

const entry = (id: string, code: string) => ({ store: "https://example.com/store", id, sha256: servedSha256(code), natives: {} });
const doc = (serial: number, entries: ReturnType<typeof entry>[], extra: object = {}) => ({
	kind: "legacy",
	schema: 1,
	serial,
	cutoff: "2026-11-23T00:00:00.000Z",
	entries,
	...extra,
});
/** A legacy.json and its .sig, signed by `key` */
const signed = (value: object, key = privateKey) => {
	const bytes = Buffer.from(JSON.stringify(value));
	return { bytes, sig: sign(null, bytes, key).toString("base64") };
};
const parse = (value: object, key = privateKey) => {
	const { bytes, sig } = signed(value, key);
	return parseLegacyList(bytes, sig, pub);
};

const A = entry("a.mjs", "code a");
const B = entry("b.mjs", "code b");
const base: LegacyList = parse(doc(1, [A, B]));

describe("old native format list", () => {
	it("accepts a list signed with the key, and nothing else", () => {
		assert.strictEqual(base.entries.length, 2);
		assert.throws(() => parse(doc(1, [A]), other), /signature does not verify/);
		const { bytes, sig } = signed(doc(1, [A]));
		// One byte changed after signing
		assert.throws(() => parseLegacyList(Buffer.from(bytes.toString().replace("a.mjs", "c.mjs")), sig, pub), /signature/);
		assert.throws(() => parseLegacyList(bytes, "", pub), /signature/);
		// Another file the registry signs with the same key
		assert.throws(() => parse(doc(1, [A], { kind: "trust" })), /kind "trust"/);
		assert.throws(() => parse(doc(0, [A])), /serial/);
		assert.throws(() => parse(doc(1, [{ ...A, sha256: "x" }])), /malformed/);
	});

	it("only shrinks: an added or changed entry, a rollback or another cut-off is refused", () => {
		assert.deepStrictEqual(replacesList(undefined, base), { ok: true });
		assert.deepStrictEqual(replacesList(base, parse(doc(2, [A]))), { ok: true });
		assert.deepStrictEqual(replacesList(base, parse(doc(1, [A, B]))), { ok: true });

		const C = entry("c.mjs", "code c");
		assert.match((replacesList(base, parse(doc(2, [A, B, C]))) as { reason: string }).reason, /adds c\.mjs/);
		// An entry's hash changed is an entry added
		assert.match((replacesList(base, parse(doc(2, [A, entry("b.mjs", "code b2")]))) as { reason: string }).reason, /adds b\.mjs/);
		assert.match(
			(replacesList(base, parse(doc(2, [A, { ...B, natives: { "x.native.ts": sha("x") } }]))) as { reason: string }).reason,
			/changes b\.mjs/,
		);
		const shrunk = parse(doc(3, [A]));
		assert.match((replacesList(shrunk, parse(doc(2, [A]))) as { reason: string }).reason, /rollback/);
		// A replayed older, bigger list
		assert.match((replacesList(shrunk, base) as { reason: string }).reason, /rollback/);
		assert.match((replacesList(base, parse(doc(2, [A], { cutoff: "2027-01-01T00:00:00.000Z" }))) as { reason: string }).reason, /cut-off/);
	});

	it("keeps the cached list until a fetched one may replace it, and checks the cache's signature", async () => {
		let cache: string | undefined;
		let served = signed(doc(2, [A, B]));
		const make = () =>
			createLegacyStore({
				readCache: () => cache,
				writeCache: (text) => void (cache = text),
				fetchList: async () => ({ bytes: served.bytes, sig: served.sig }),
				publicKey: pub,
				firstWaitMs: 50,
			});
		const store = make();
		assert.strictEqual(store.allows("a.mjs", A.sha256), false);
		await store.ready();
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);

		// A grown list, or a rollback, is refused: the cache stays
		const before = cache;
		served = signed(doc(3, [A, B, entry("c.mjs", "code c")]));
		await assert.rejects(store.refresh(), /adds c\.mjs/);
		served = signed(doc(1, [A, B]));
		await assert.rejects(store.refresh(), /rollback/);
		assert.strictEqual(cache, before);

		// A removal under the same serial applies
		served = signed(doc(2, [A]));
		await store.refresh();
		assert.strictEqual(store.allows("b.mjs", B.sha256), false);

		// The next start reads the cache: a grown list is still refused
		const restarted = make();
		served = signed(doc(2, [A, B]));
		await assert.rejects(restarted.refresh(), /adds b\.mjs/);
		assert.strictEqual(restarted.allows("a.mjs", A.sha256), true);

		// A cache edited by hand fails its check and isn't used
		const edited = JSON.parse(cache!);
		edited.list = Buffer.from(JSON.stringify(doc(2, [A, B]))).toString("base64");
		cache = JSON.stringify(edited);
		const tampered = make();
		served = { bytes: Buffer.from("not json"), sig: "" };
		await tampered.ready();
		assert.strictEqual(tampered.allows("b.mjs", B.sha256), false);
		assert.strictEqual(tampered.current(), undefined);
	});

	it("waits once for the first fetch when nothing is cached, and refuses meanwhile", async () => {
		let release: () => void = () => {};
		const fetched = new Promise<void>((resolve) => (release = resolve));
		const { bytes, sig } = signed(doc(1, [A]));
		const store = createLegacyStore({
			readCache: () => undefined,
			writeCache: () => {},
			fetchList: async () => (await fetched, { bytes, sig }),
			publicKey: pub,
			firstWaitMs: 20,
		});
		const started = Date.now();
		await Promise.all([store.ready(), store.ready()]);
		assert.ok(Date.now() - started < 1000);
		assert.strictEqual(store.allows("a.mjs", A.sha256), false);
		release();
		await store.ready();
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
	});

	it("allows exactly the listed code of a listed plugin", () => {
		assert.strictEqual(listAllows(base, "https://example.com/store/a.mjs", "code a"), true);
		// Served from another store (it moved): the id and the code decide
		assert.strictEqual(listAllows(base, "https://example.org/x/a.mjs", "code a"), true);
		// The sourceURL line Luna adds doesn't count
		assert.strictEqual(listAllows(base, "https://example.com/store/a.mjs", "code a\n//# sourceURL=https://example.com/store/a.mjs"), true);
		// An update
		assert.strictEqual(listAllows(base, "https://example.com/store/a.mjs", "code a2"), false);
		// Listed code under another name
		assert.strictEqual(listAllows(base, "https://example.com/store/c.mjs", "code a"), false);
		assert.strictEqual(listAllows(undefined, "https://example.com/store/a.mjs", "code a"), false);
	});
});
