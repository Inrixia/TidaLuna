import { describe, expect, it } from "vitest";

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
		expect(base.entries.length).toBe(2);
		expect(() => parse(doc(1, [A]), other)).toThrow(/signature does not verify/);
		const { bytes, sig } = signed(doc(1, [A]));
		// One byte changed after signing
		expect(() => parseLegacyList(Buffer.from(bytes.toString().replace("a.mjs", "c.mjs")), sig, pub)).toThrow(/signature/);
		expect(() => parseLegacyList(bytes, "", pub)).toThrow(/signature/);
		// Another file the registry signs with the same key
		expect(() => parse(doc(1, [A], { kind: "trust" }))).toThrow(/kind "trust"/);
		expect(() => parse(doc(0, [A]))).toThrow(/serial/);
		expect(() => parse(doc(1, [{ ...A, sha256: "x" }]))).toThrow(/malformed/);
	});

	it("only shrinks: an added or changed entry, a rollback or another cut-off is refused", () => {
		expect(replacesList(undefined, base)).toStrictEqual({ ok: true });
		expect(replacesList(base, parse(doc(2, [A])))).toStrictEqual({ ok: true });
		expect(replacesList(base, parse(doc(1, [A, B])))).toStrictEqual({ ok: true });

		const C = entry("c.mjs", "code c");
		expect((replacesList(base, parse(doc(2, [A, B, C]))) as { reason: string }).reason).toMatch(/adds c\.mjs/);
		// An entry's hash changed is an entry added
		expect((replacesList(base, parse(doc(2, [A, entry("b.mjs", "code b2")]))) as { reason: string }).reason).toMatch(/adds b\.mjs/);
		expect((replacesList(base, parse(doc(2, [A, { ...B, natives: { "x.native.ts": sha("x") } }]))) as { reason: string }).reason).toMatch(
			/changes b\.mjs/,
		);
		const shrunk = parse(doc(3, [A]));
		expect((replacesList(shrunk, parse(doc(2, [A]))) as { reason: string }).reason).toMatch(/rollback/);
		// A replayed older, bigger list
		expect((replacesList(shrunk, base) as { reason: string }).reason).toMatch(/rollback/);
		expect((replacesList(base, parse(doc(2, [A], { cutoff: "2027-01-01T00:00:00.000Z" }))) as { reason: string }).reason).toMatch(/cut-off/);
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
		expect(store.allows("a.mjs", A.sha256)).toBe(false);
		await store.ready();
		expect(store.allows("a.mjs", A.sha256)).toBe(true);

		// A grown list, or a rollback, is refused: the cache stays
		const before = cache;
		served = signed(doc(3, [A, B, entry("c.mjs", "code c")]));
		await expect(store.refresh()).rejects.toThrow(/adds c\.mjs/);
		served = signed(doc(1, [A, B]));
		await expect(store.refresh()).rejects.toThrow(/rollback/);
		expect(cache).toBe(before);

		// A removal under the same serial applies
		served = signed(doc(2, [A]));
		await store.refresh();
		expect(store.allows("b.mjs", B.sha256)).toBe(false);

		// The next start reads the cache: a grown list is still refused
		const restarted = make();
		served = signed(doc(2, [A, B]));
		await expect(restarted.refresh()).rejects.toThrow(/adds b\.mjs/);
		expect(restarted.allows("a.mjs", A.sha256)).toBe(true);

		// A cache edited by hand fails its check and isn't used
		const edited = JSON.parse(cache!);
		edited.list = Buffer.from(JSON.stringify(doc(2, [A, B]))).toString("base64");
		cache = JSON.stringify(edited);
		const tampered = make();
		served = { bytes: Buffer.from("not json"), sig: "" };
		await tampered.ready();
		expect(tampered.allows("b.mjs", B.sha256)).toBe(false);
		expect(tampered.current()).toBe(undefined);
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
		await expect(store.refresh()).rejects.toThrow(/can't be read yet/);
		expect(store.allows("b.mjs", B.sha256)).toBe(false);
		// Readable again: the cached serial 5 refuses the older list
		locked = false;
		await expect(store.refresh()).rejects.toThrow(/rollback/);
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
		expect(writes.length).toBe(0);

		cache = "{broken";
		const broken = createLegacyStore({
			readCache: () => cache,
			writeCache: (text) => void writes.push(text),
			fetchList: async () => older,
			publicKey: pub,
		});
		await expect(broken.refresh()).rejects.toThrow(/fails its check/);
		expect(broken.allows("b.mjs", B.sha256)).toBe(false);
		expect(writes.length).toBe(0);
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
		expect(Date.now() - started < 1000).toBeTruthy();
		expect(store.allows("a.mjs", A.sha256)).toBe(false);
		release();
		await fetched;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
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
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
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
		expect(fetches).toBe(1);
		time = 100;
		store.allows("a.mjs", A.sha256);
		await settle();
		expect(fetches).toBe(2);
		// The next wait is longer
		time = 600;
		online = true;
		store.allows("a.mjs", A.sha256);
		await settle();
		expect(fetches).toBe(2);
		time = 1100;
		store.allows("a.mjs", A.sha256);
		await settle();
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
		// Accepted: no more fetches of its own (the 6 h refresh is legacyListMain's)
		time = 99999;
		store.allows("a.mjs", A.sha256);
		await settle();
		expect(fetches).toBe(3);
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
		expect(store.allows("b.mjs", B.sha256)).toBe(true);
		served = signed(doc(2, [A]));
		await store.refresh();
		expect(store.allows("b.mjs", B.sha256)).toBe(false);
		// Still the only-shrinks rule against the list in use
		served = first;
		await expect(store.refresh()).rejects.toThrow(/rollback/);
		expect(store.allows("b.mjs", B.sha256)).toBe(false);
		// Not tried again before the wait
		locked = false;
		store.allows("a.mjs", A.sha256);
		expect(JSON.parse(cache).list).toBe(first.bytes.toString("base64"));
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
		expect(offline.allows("a.mjs", A.sha256)).toBe(true);
		expect(offline.allows("b.mjs", B.sha256)).toBe(false);
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
		expect(store.allows("b.mjs", B.sha256)).toBe(true);
		await settle();
		online = true;
		time = 100;
		store.allows("b.mjs", B.sha256);
		await settle();
		expect(fetches).toBe(2);
		expect(store.allows("b.mjs", B.sha256)).toBe(false);
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
		expect(fetches).toBe(2);
		expect(store.allows("b.mjs", B.sha256)).toBe(false);
		// The scheduled refresh fails: the next check after the wait fetches again
		served = { bytes: Buffer.from("offline"), sig: "" };
		await store.refreshNow();
		served = signed(doc(3, []));
		time = 150;
		store.allows("a.mjs", A.sha256);
		await settle();
		expect(fetches).toBe(3);
		time = 200;
		store.allows("a.mjs", A.sha256);
		await settle();
		expect(fetches).toBe(4);
		expect(store.allows("a.mjs", A.sha256)).toBe(false);
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
			expect(store.allows("a.mjs", A.sha256)).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(logs.length).toBe(1);
		expect(logs[0]).toMatch(/can't be read now: EACCES/);
	});

	it("needs a validUntil; a later list may be valid for less long (a wrong far-off date can't lock it)", () => {
		expect(() => parse(doc(1, [A], { validUntil: undefined }))).toThrow(/validUntil/);
		expect(() => parse(doc(1, [A], { validUntil: "soon" }))).toThrow(/validUntil/);
		expect(() => parse(doc(1, [A], { validUntil: 4102444800000 }))).toThrow(/validUntil/);
		const later = parse(doc(2, [A, B], { validUntil: "2099-02-01T00:00:00.000Z" }));
		expect(replacesList(base, later)).toStrictEqual({ ok: true });
		expect(replacesList(later, parse(doc(3, [A])))).toStrictEqual({ ok: true });
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
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
		// Past validUntil, within the skew: still grants
		time.now = at(until) + 2 * DAY - 1;
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
		time.now = at(until) + 2 * DAY;
		expect(store.usable()).toBe(false);
		expect(store.allows("a.mjs", A.sha256)).toBe(false);
		expect(logs.some((line) => /grants nothing until a fresh one is fetched: expired 2026-12-01/.test(line))).toBeTruthy();
		// The registry still serves the expired one: refused, nothing granted
		await expect(store.refresh()).rejects.toThrow(/refused: expired/);
		expect(store.allows("a.mjs", A.sha256)).toBe(false);
		// A fresh one, signed again (a subset): grants again
		served = doc(6, [A], { validUntil: "2027-01-01T00:00:00.000Z" });
		await store.refresh();
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
		expect(store.allows("b.mjs", B.sha256)).toBe(false);
	});

	it("fetches at once when the list expires while running, not on the next scheduled refresh", async () => {
		const until = "2026-12-01T00:00:00.000Z";
		const time = { now: at(until) - DAY };
		let fetches = 0;
		let served: object = doc(5, [A], { validUntil: until });
		const { store } = storeAt(time, undefined, () => (fetches++, served));
		await store.ready();
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
		expect(fetches).toBe(1);
		// Signed again meanwhile; the cached one runs out
		served = doc(6, [A], { validUntil: "2027-01-01T00:00:00.000Z" });
		time.now = at(until) + 3 * DAY;
		expect(store.allows("a.mjs", A.sha256)).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fetches).toBe(2);
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
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
		expect(fetches).toBe(1);
		served = doc(6, [A], { validUntil: "2027-01-01T00:00:00.000Z" });
		slow = true;
		time.now = at(until) + 3 * DAY;
		for (let i = 0; i < 10; i++) expect(store.allows("a.mjs", A.sha256)).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		for (let i = 0; i < 10; i++) store.allows("a.mjs", A.sha256);
		expect(fetches).toBe(2);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
		expect(fetches).toBe(2);
	});

	it("the scheduled refresh starts no second fetch while one runs", async () => {
		const until = "2026-12-01T00:00:00.000Z";
		const time = { now: at(until) - DAY };
		let fetches = 0;
		let slow = false;
		const { store } = storeAt(time, undefined, async () => {
			fetches++;
			if (slow) await new Promise((resolve) => setTimeout(resolve, 50));
			return doc(5 + fetches, [A], { validUntil: fetches === 1 ? until : "2027-01-01T00:00:00.000Z" });
		});
		await store.ready();
		slow = true;
		time.now = at(until) + 3 * DAY;
		expect(store.allows("a.mjs", A.sha256)).toBe(false);
		const scheduled = store.refreshNow();
		expect(fetches).toBe(2);
		await scheduled;
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
		expect(fetches).toBe(2);
	});

	it("ready waits for the fetch when the list ran out while running (the confirmations can say what runs)", async () => {
		const until = "2026-12-01T00:00:00.000Z";
		const time = { now: at(until) - DAY };
		let fetches = 0;
		let served: object = doc(5, [A], { validUntil: until });
		const { store } = storeAt(time, undefined, () => (fetches++, served));
		await store.ready();
		expect(fetches).toBe(1);
		served = doc(6, [A], { validUntil: "2027-01-01T00:00:00.000Z" });
		time.now = at(until) + 3 * DAY;
		await store.ready();
		expect(fetches).toBe(2);
		expect(store.usable()).toBe(true);
	});

	for (const by of ["allows", "refreshNow"] as const)
		it(`ready waits for the fetch ${by} started when the list ran out while running`, async () => {
			const until = "2026-12-01T00:00:00.000Z";
			const time = { now: at(until) - DAY };
			let fetches = 0;
			let slow = false;
			const { store } = storeAt(time, undefined, async () => {
				fetches++;
				if (slow) await new Promise((resolve) => setTimeout(resolve, 30));
				return doc(5 + fetches, [A], { validUntil: fetches === 1 ? until : "2027-01-01T00:00:00.000Z" });
			});
			await store.ready();
			slow = true;
			time.now = at(until) + 3 * DAY;
			if (by === "allows") expect(store.allows("a.mjs", A.sha256)).toBe(false);
			else void store.refreshNow();
			await store.ready();
			expect(fetches).toBe(2);
			expect(store.usable()).toBe(true);
		});

	it("a list running out after a failed refresh still gets its fetch at once, and ready waits for it", async () => {
		const until = "2026-12-01T00:00:00.000Z";
		const time = { now: at(until) - DAY };
		let fetches = 0;
		let online = true;
		const { store } = storeAt(
			time,
			undefined,
			() => {
				fetches++;
				if (!online) throw new Error("offline");
				return doc(5 + fetches, [A], { validUntil: fetches === 1 ? until : "2027-01-01T00:00:00.000Z" });
			},
			{ retryMs: [60 * 60 * 1000] },
		);
		await store.ready();
		online = false;
		await store.refreshNow();
		expect(fetches).toBe(2);
		online = true;
		time.now = at(until) + 3 * DAY;
		await store.ready();
		expect(fetches).toBe(3);
		expect(store.usable()).toBe(true);
	});

	it("a cache expired at start: later checks don't make the first wait longer", async () => {
		const time = { now: at("2026-12-10T00:00:00.000Z") };
		const { store } = storeAt(time, doc(5, [A], { validUntil: "2026-12-01T00:00:00.000Z" }), () => new Promise<object>(() => {}));
		const first = store.ready();
		time.now += 40;
		const t0 = Date.now();
		await store.ready();
		expect(Date.now() - t0 < 35, `waited ${Date.now() - t0} ms`).toBeTruthy();
		await first;
	});

	it("an expired cache stays the base: a fresh list must still be a subset of it", async () => {
		const time = { now: at("2027-01-10T00:00:00.000Z") };
		const C = entry("c.mjs", "code c");
		const { store } = storeAt(time, doc(5, [A], { validUntil: "2027-01-01T00:00:00.000Z" }), () =>
			doc(7, [A, C], { validUntil: "2027-02-01T00:00:00.000Z" }),
		);
		await store.ready();
		expect(store.usable()).toBe(false);
		await expect(store.refresh()).rejects.toThrow(/adds c\.mjs/);
		expect(store.allows("c.mjs", C.sha256)).toBe(false);
	});

	it("waits on a start with an expired cache for a fresh list, like with none", async () => {
		const time = { now: at("2027-01-10T00:00:00.000Z") };
		const { store } = storeAt(time, doc(5, [A], { validUntil: "2027-01-01T00:00:00.000Z" }), () =>
			doc(6, [A], { validUntil: "2027-02-01T00:00:00.000Z" }),
		);
		await store.ready();
		expect(store.allows("a.mjs", A.sha256)).toBe(true);
		expect(store.current()?.serial).toBe(6);
	});

	it("takes no list older than this build, fetched on a first start or cached", async () => {
		const time = { now: at("2026-12-01T00:00:00.000Z") };
		// Nothing cached, an older signed list replayed: refused
		const first = storeAt(time, undefined, () => doc(3, [A, B]), { minSerial: 4 });
		await first.store.ready();
		expect(first.store.allows("a.mjs", A.sha256)).toBe(false);
		expect(first.store.current()).toBe(undefined);
		await expect(first.store.refresh()).rejects.toThrow(/refused: serial 3 is older than this build \(4\)/);
		// A cache older than the build (written by an older Luna): the base, granting nothing until a newer list
		let served: object = doc(3, [A, B]);
		const cached = storeAt(time, doc(3, [A, B]), () => served, { minSerial: 4 });
		await cached.store.ready();
		expect(cached.store.allows("a.mjs", A.sha256)).toBe(false);
		served = doc(4, [A]);
		await cached.store.refresh();
		expect(cached.store.allows("a.mjs", A.sha256)).toBe(true);
		expect(cached.store.allows("b.mjs", B.sha256)).toBe(false);
	});

	it("allows exactly the listed code of a listed plugin", () => {
		expect(listAllows(base, "https://example.com/store/a.mjs", "code a")).toBe(true);
		// Served from another store (it moved): the id and the code decide
		expect(listAllows(base, "https://example.org/x/a.mjs", "code a")).toBe(true);
		// The sourceURL line Luna adds doesn't count
		expect(listAllows(base, "https://example.com/store/a.mjs", "code a\n//# sourceURL=https://example.com/store/a.mjs")).toBe(true);
		// An update
		expect(listAllows(base, "https://example.com/store/a.mjs", "code a2")).toBe(false);
		// Listed code under another name
		expect(listAllows(base, "https://example.com/store/c.mjs", "code a")).toBe(false);
		expect(listAllows(undefined, "https://example.com/store/a.mjs", "code a")).toBe(false);
	});
});
