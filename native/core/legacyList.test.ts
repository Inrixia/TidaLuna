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
	validUntil: "2099-01-01T00:00:00.000Z",
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

	it("takes no fetched list while the cache can't be read or fails its check: an older one can't come back", async () => {
		const good = signed(doc(5, [A]));
		const older = signed(doc(4, [A, B]));
		let locked = true;
		let cache: string | undefined = JSON.stringify({ list: good.bytes.toString("base64"), sig: good.sig });
		const writes: string[] = [];
		const store = createLegacyStore({
			readCache: () => {
				if (locked) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
				return cache;
			},
			writeCache: (text) => void writes.push(text),
			fetchList: async () => older,
			publicKey: pub,
		});
		await assert.rejects(store.refresh(), /can't be read yet/);
		assert.strictEqual(store.allows("b.mjs", B.sha256), false);
		// Readable again: the cached serial 5 refuses the older list
		locked = false;
		await assert.rejects(store.refresh(), /rollback/);
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
		assert.strictEqual(writes.length, 0);

		cache = "{broken";
		const broken = createLegacyStore({
			readCache: () => cache,
			writeCache: (text) => void writes.push(text),
			fetchList: async () => older,
			publicKey: pub,
		});
		await assert.rejects(broken.refresh(), /fails its check/);
		assert.strictEqual(broken.allows("b.mjs", B.sha256), false);
		assert.strictEqual(writes.length, 0);
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
		await fetched;
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
	});

	it("waits for a cache locked at the start, and reads it once it is free", async () => {
		const { bytes, sig } = signed(doc(1, [A]));
		let locked = 3;
		const store = createLegacyStore({
			readCache: () => {
				if (locked-- > 0) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
				return JSON.stringify({ list: bytes.toString("base64"), sig });
			},
			writeCache: () => {},
			fetchList: async () => {
				throw new Error("offline");
			},
			publicKey: pub,
			firstWaitMs: 5000,
		});
		await store.ready();
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
	});

	it("fetches again while no list was ever accepted, after a growing wait", async () => {
		const { bytes, sig } = signed(doc(1, [A]));
		let time = 0;
		let online = false;
		let fetches = 0;
		const store = createLegacyStore({
			readCache: () => undefined,
			writeCache: () => {},
			fetchList: async () => {
				fetches++;
				if (!online) throw new Error("offline");
				return { bytes, sig };
			},
			publicKey: pub,
			retryMs: [100, 1000],
			now: () => time,
		});
		const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
		store.allows("a.mjs", A.sha256);
		await settle();
		store.allows("a.mjs", A.sha256);
		await settle();
		assert.strictEqual(fetches, 1);
		time = 100;
		store.allows("a.mjs", A.sha256);
		await settle();
		assert.strictEqual(fetches, 2);
		// The next wait is longer
		time = 600;
		online = true;
		store.allows("a.mjs", A.sha256);
		await settle();
		assert.strictEqual(fetches, 2);
		time = 1100;
		store.allows("a.mjs", A.sha256);
		await settle();
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
		// Accepted: no more fetches of its own (the 6 h refresh is legacyListMain's)
		time = 99999;
		store.allows("a.mjs", A.sha256);
		await settle();
		assert.strictEqual(fetches, 3);
	});

	it("applies a smaller list at once even if it can't be cached, and caches it once it can", async () => {
		const first = signed(doc(1, [A, B]));
		let served = first;
		let locked = true;
		let time = 0;
		let cache = JSON.stringify({ list: first.bytes.toString("base64"), sig: first.sig });
		const store = createLegacyStore({
			readCache: () => cache,
			writeCache: (text) => {
				if (locked) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
				cache = text;
			},
			fetchList: async () => served,
			publicKey: pub,
			now: () => time,
		});
		assert.strictEqual(store.allows("b.mjs", B.sha256), true);
		served = signed(doc(2, [A]));
		await store.refresh();
		assert.strictEqual(store.allows("b.mjs", B.sha256), false);
		// Still the only-shrinks rule against the list in use
		served = first;
		await assert.rejects(store.refresh(), /rollback/);
		assert.strictEqual(store.allows("b.mjs", B.sha256), false);
		// Not tried again before the wait
		locked = false;
		store.allows("a.mjs", A.sha256);
		assert.strictEqual(JSON.parse(cache).list, first.bytes.toString("base64"));
		time = 30000;
		// Writable again, and offline: the next check writes it (no fetch needed), so a start offline keeps it
		locked = false;
		served = { bytes: Buffer.from("offline"), sig: "" };
		store.allows("a.mjs", A.sha256);
		const offline = createLegacyStore({
			readCache: () => cache,
			writeCache: () => {},
			fetchList: async () => {
				throw new Error("offline");
			},
			publicKey: pub,
		});
		assert.strictEqual(offline.allows("a.mjs", A.sha256), true);
		assert.strictEqual(offline.allows("b.mjs", B.sha256), false);
	});

	it("fetches again after an offline start with a cached list, and takes a removal once online", async () => {
		const cached = signed(doc(1, [A, B]));
		let time = 0;
		let online = false;
		let fetches = 0;
		const store = createLegacyStore({
			readCache: () => JSON.stringify({ list: cached.bytes.toString("base64"), sig: cached.sig }),
			writeCache: () => {},
			fetchList: async () => {
				fetches++;
				if (!online) throw new Error("offline");
				return signed(doc(2, [A]));
			},
			publicKey: pub,
			retryMs: [100],
			now: () => time,
		});
		const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
		assert.strictEqual(store.allows("b.mjs", B.sha256), true);
		await settle();
		online = true;
		time = 100;
		store.allows("b.mjs", B.sha256);
		await settle();
		assert.strictEqual(fetches, 2);
		assert.strictEqual(store.allows("b.mjs", B.sha256), false);
	});

	it("tries again soon after a fetched list that can't be used, and after a failed scheduled refresh", async () => {
		const cached = signed(doc(1, [A, B]));
		let time = 0;
		let served: { bytes: Buffer; sig: string } = { bytes: Buffer.from("<html>portal</html>"), sig: "" };
		let fetches = 0;
		const store = createLegacyStore({
			readCache: () => JSON.stringify({ list: cached.bytes.toString("base64"), sig: cached.sig }),
			writeCache: () => {},
			fetchList: async () => (fetches++, served),
			publicKey: pub,
			retryMs: [100],
			now: () => time,
		});
		const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
		store.allows("b.mjs", B.sha256);
		await settle();
		served = signed(doc(2, [A]));
		time = 100;
		store.allows("b.mjs", B.sha256);
		await settle();
		assert.strictEqual(fetches, 2);
		assert.strictEqual(store.allows("b.mjs", B.sha256), false);
		// The scheduled refresh fails: the next check after the wait fetches again
		served = { bytes: Buffer.from("offline"), sig: "" };
		await store.refreshNow();
		served = signed(doc(3, []));
		time = 150;
		store.allows("a.mjs", A.sha256);
		await settle();
		assert.strictEqual(fetches, 3);
		time = 200;
		store.allows("a.mjs", A.sha256);
		await settle();
		assert.strictEqual(fetches, 4);
		assert.strictEqual(store.allows("a.mjs", A.sha256), false);
	});

	it("logs a cache that can't be read once, not on every check", async () => {
		const logs: string[] = [];
		const store = createLegacyStore({
			readCache: () => {
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			},
			writeCache: () => {},
			fetchList: async () => {
				throw new Error("not reached");
			},
			publicKey: pub,
			log: (message) => void logs.push(message),
		});
		for (let i = 0; i < 20; i++) {
			assert.strictEqual(store.allows("a.mjs", A.sha256), false);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		assert.strictEqual(logs.length, 1);
		assert.match(logs[0], /can't be read now: EACCES/);
	});

	it("needs a validUntil; a later list may be valid for less long (a wrong far-off date can't lock it)", () => {
		assert.throws(() => parse(doc(1, [A], { validUntil: undefined })), /validUntil/);
		assert.throws(() => parse(doc(1, [A], { validUntil: "soon" })), /validUntil/);
		assert.throws(() => parse(doc(1, [A], { validUntil: 4102444800000 })), /validUntil/);
		const later = parse(doc(2, [A, B], { validUntil: "2099-02-01T00:00:00.000Z" }));
		assert.deepStrictEqual(replacesList(base, later), { ok: true });
		assert.deepStrictEqual(replacesList(later, parse(doc(3, [A]))), { ok: true });
	});

	const DAY = 24 * 60 * 60 * 1000;
	const at = (iso: string) => Date.parse(iso);
	/** A store over `cached` (a signed doc or none) fetching `fetched()`, at the time `time.now` */
	const storeAt = (time: { now: number }, cached: object | undefined, fetched: () => object | Promise<object>, extra: object = {}) => {
		let cache: string | undefined;
		if (cached !== undefined) {
			const { bytes, sig } = signed(cached);
			cache = JSON.stringify({ list: bytes.toString("base64"), sig });
		}
		const logs: string[] = [];
		const store = createLegacyStore({
			readCache: () => cache,
			writeCache: (text) => void (cache = text),
			fetchList: async () => signed(await fetched()),
			publicKey: pub,
			firstWaitMs: 50,
			retryMs: [0],
			now: () => time.now,
			log: (message) => void logs.push(message),
			...extra,
		});
		return { store, logs };
	};

	it("an expired list grants nothing until a fresh one comes, with two days for a clock that is ahead", async () => {
		const until = "2026-12-01T00:00:00.000Z";
		const time = { now: at(until) - DAY };
		let served: object = doc(5, [A, B], { validUntil: until });
		const { store, logs } = storeAt(time, doc(5, [A, B], { validUntil: until }), () => served);
		await store.ready();
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
		// Past validUntil, within the skew: still grants
		time.now = at(until) + 2 * DAY - 1;
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
		time.now = at(until) + 2 * DAY;
		assert.strictEqual(store.usable(), false);
		assert.strictEqual(store.allows("a.mjs", A.sha256), false);
		assert.ok(logs.some((line) => /grants nothing until a fresh one is fetched: expired 2026-12-01/.test(line)));
		// The registry still serves the expired one: refused, nothing granted
		await assert.rejects(store.refresh(), /refused: expired/);
		assert.strictEqual(store.allows("a.mjs", A.sha256), false);
		// A fresh one, signed again (a subset): grants again
		served = doc(6, [A], { validUntil: "2027-01-01T00:00:00.000Z" });
		await store.refresh();
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
		assert.strictEqual(store.allows("b.mjs", B.sha256), false);
	});

	it("fetches at once when the list expires while running, not on the next scheduled refresh", async () => {
		const until = "2026-12-01T00:00:00.000Z";
		const time = { now: at(until) - DAY };
		let fetches = 0;
		let served: object = doc(5, [A], { validUntil: until });
		const { store } = storeAt(time, undefined, () => (fetches++, served));
		await store.ready();
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
		assert.strictEqual(fetches, 1);
		// Signed again meanwhile; the cached one runs out
		served = doc(6, [A], { validUntil: "2027-01-01T00:00:00.000Z" });
		time.now = at(until) + 3 * DAY;
		assert.strictEqual(store.allows("a.mjs", A.sha256), false);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.strictEqual(fetches, 2);
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
	});

	it("one fetch at a time: checks while an expired list is being fetched again start no other", async () => {
		const until = "2026-12-01T00:00:00.000Z";
		const time = { now: at(until) - DAY };
		let fetches = 0;
		let served: object = doc(5, [A], { validUntil: until });
		let slow = false;
		const { store } = storeAt(time, undefined, async () => {
			fetches++;
			if (slow) await new Promise((resolve) => setTimeout(resolve, 50));
			return served;
		});
		await store.ready();
		assert.strictEqual(fetches, 1);
		served = doc(6, [A], { validUntil: "2027-01-01T00:00:00.000Z" });
		slow = true;
		time.now = at(until) + 3 * DAY;
		for (let i = 0; i < 10; i++) assert.strictEqual(store.allows("a.mjs", A.sha256), false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		for (let i = 0; i < 10; i++) store.allows("a.mjs", A.sha256);
		assert.strictEqual(fetches, 2);
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
		assert.strictEqual(fetches, 2);
	});

	it("an expired cache stays the base: a fresh list must still be a subset of it", async () => {
		const time = { now: at("2027-01-10T00:00:00.000Z") };
		const C = entry("c.mjs", "code c");
		const { store } = storeAt(time, doc(5, [A], { validUntil: "2027-01-01T00:00:00.000Z" }), () =>
			doc(7, [A, C], { validUntil: "2027-02-01T00:00:00.000Z" }),
		);
		await store.ready();
		assert.strictEqual(store.usable(), false);
		await assert.rejects(store.refresh(), /adds c\.mjs/);
		assert.strictEqual(store.allows("c.mjs", C.sha256), false);
	});

	it("waits on a start with an expired cache for a fresh list, like with none", async () => {
		const time = { now: at("2027-01-10T00:00:00.000Z") };
		const { store } = storeAt(time, doc(5, [A], { validUntil: "2027-01-01T00:00:00.000Z" }), () =>
			doc(6, [A], { validUntil: "2027-02-01T00:00:00.000Z" }),
		);
		await store.ready();
		assert.strictEqual(store.allows("a.mjs", A.sha256), true);
		assert.strictEqual(store.current()?.serial, 6);
	});

	it("takes no list older than this build, fetched on a first start or cached", async () => {
		const time = { now: at("2026-12-01T00:00:00.000Z") };
		// Nothing cached, an older signed list replayed: refused
		const first = storeAt(time, undefined, () => doc(3, [A, B]), { minSerial: 4 });
		await first.store.ready();
		assert.strictEqual(first.store.allows("a.mjs", A.sha256), false);
		assert.strictEqual(first.store.current(), undefined);
		await assert.rejects(first.store.refresh(), /refused: serial 3 is older than this build \(4\)/);
		// A cache older than the build (written by an older Luna): the base, granting nothing until a newer list
		let served: object = doc(3, [A, B]);
		const cached = storeAt(time, doc(3, [A, B]), () => served, { minSerial: 4 });
		await cached.store.ready();
		assert.strictEqual(cached.store.allows("a.mjs", A.sha256), false);
		served = doc(4, [A]);
		await cached.store.refresh();
		assert.strictEqual(cached.store.allows("a.mjs", A.sha256), true);
		assert.strictEqual(cached.store.allows("b.mjs", B.sha256), false);
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
