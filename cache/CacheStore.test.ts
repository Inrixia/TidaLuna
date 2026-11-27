import { describe, expect, it } from "vitest";

import { AsyncMapBackend } from "test/AsyncMapBackend";
import { StreamOnlyBackend } from "test/StreamOnlyBackend";
import type { CacheMeta } from "./Cache.types";
import { CacheStore } from "./CacheStore";
import type { ReconcileResult } from "./CacheStoreBackend";
import { MapBackend } from "./MapBackend";
import { bytesStream, readAll } from "./streams";

const metaOf = (bytes = 0): CacheMeta => ({ bytes, crf: 1, last: 0, written: Date.now() });

describe("CacheStore over sync backends", () => {
	it("reads and writes synchronously, counting value and meta bytes", () => {
		const store = new CacheStore({ meta: new MapBackend(), data: new MapBackend<string>() });
		expect(store.loaded).toBe(true);
		expect(store.set("a", "value", metaOf(5))).toBeUndefined();
		expect(store.get("a")).toBe("value");
		expect(store.has("a")).toBe(true);
		expect(store.dataBytes).toBe(5);
		expect(store.metaBytes).toBeGreaterThan(0);
		expect(store.bytes).toBe(store.dataBytes + store.metaBytes);
		expect(store.get("missing")).toBeUndefined();
		expect(store.stats()).toMatchObject({ entries: 1, hits: 1, misses: 1, dataBytes: 5 });
	});

	it("frees the bytes of a replaced or deleted value", () => {
		const store = new CacheStore({ meta: new MapBackend(), data: new MapBackend<string>() });
		store.set("a", "one", metaOf(10));
		store.set("a", "two", metaOf(3));
		expect(store.dataBytes).toBe(3);
		store.del("a");
		expect(store.bytes).toBe(0);
		expect(store.get("a")).toBeUndefined();
	});

	it("streams a value from a backend that only gets, end inclusive", async () => {
		const store = new CacheStore({ meta: new MapBackend(), data: new MapBackend<Uint8Array>() });
		store.set("a", new Uint8Array([0, 1, 2, 3, 4]), metaOf(5));
		const stream = store.getStream("a", { start: 1, end: 3 });
		expect(await readAll(stream!)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("won't stream a value that isn't binary", () => {
		const store = new CacheStore({ meta: new MapBackend(), data: new MapBackend<string>() });
		store.set("a", "text", metaOf(4));
		expect(() => store.getStream("a")).toThrow("map backend does not stream");
	});

	it("measures by the data backend's sizeOf", () => {
		const store = new CacheStore({ meta: new MapBackend(), data: new MapBackend<string>() });
		expect(store.measure("abcd")).toBe(new MapBackend().sizeOf("abcd"));
	});
});

describe("CacheStore over async backends", () => {
	it("loads metas and settings from the meta backend", async () => {
		const meta = new AsyncMapBackend();
		const data = new AsyncMapBackend<string>();
		await data.set("a", "value");
		await meta.set("a", metaOf(5));
		await meta.set(CacheStore.settingsKey, { userBytesLimit: 100 });
		const store = new CacheStore({ meta, data });
		expect(store.loaded).toBe(false);
		await store.ready;
		expect([...store.keys()]).toEqual(["a"]);
		expect(store.settings).toEqual({ userBytesLimit: 100 });
		expect(await store.get("a")).toBe("value");
		expect(store.dataBytes).toBe(5);
	});

	it("drops metas whose value is gone and deletes values without a meta", async () => {
		const meta = new AsyncMapBackend();
		const data = new AsyncMapBackend<string>();
		await meta.set("noValue", metaOf(1));
		await data.set("noMeta", "orphan");
		const store = new CacheStore({ meta, data });
		await store.ready;
		expect(store.has("noValue")).toBe(false);
		expect(data.values.has("noMeta")).toBe(false);
		await store.flush();
		expect(meta.values.has("noValue")).toBe(false);
	});

	it("keeps the orphans a backend's reconcile names, for its owner to adopt", async () => {
		const data = new AsyncMapBackend<string>();
		const reconciling = Object.assign(data, {
			reconcile: async (): Promise<ReconcileResult> => ({ missing: [], orphans: ["file.flac"] }),
		});
		const store = new CacheStore({ meta: new AsyncMapBackend(), data: reconciling });
		await store.ready;
		expect(store.orphans).toEqual(["file.flac"]);
	});

	it("saves changed metas in a batch, and deleted ones", async () => {
		const meta = new AsyncMapBackend();
		const store = new CacheStore({ meta, data: new AsyncMapBackend<string>() });
		await store.ready;
		await store.set("a", "one", metaOf(3));
		await store.set("b", "two", metaOf(3));
		expect(meta.values.size).toBe(0);
		await store.flush();
		expect([...meta.values.keys()]).toEqual(["a", "b"]);
		await store.del("a");
		await store.flush();
		expect([...meta.values.keys()]).toEqual(["b"]);
	});

	it("tries a failed meta save again with the next one", async () => {
		const meta = new AsyncMapBackend();
		const store = new CacheStore({ meta, data: new AsyncMapBackend<string>() });
		await store.ready;
		await store.set("a", "one", metaOf(3));
		meta.fail.add("set");
		await store.flush();
		expect(meta.values.has("a")).toBe(false);
		meta.fail.delete("set");
		await store.flush();
		expect(meta.values.has("a")).toBe(true);
	});

	it("saves settings under the settings key", async () => {
		const meta = new AsyncMapBackend();
		const store = new CacheStore({ meta, data: new AsyncMapBackend<string>() });
		await store.ready;
		store.setSettings({ userBytesLimit: 5 });
		await store.flush();
		expect(meta.values.get(CacheStore.settingsKey)).toEqual({ userBytesLimit: 5 });
	});

	it("stays empty and saves nothing after a failed load", async () => {
		const meta = new AsyncMapBackend();
		await meta.set("a", metaOf(1));
		meta.fail.add("keys");
		const store = new CacheStore({ meta, data: new AsyncMapBackend<string>() });
		await store.ready;
		expect(store.loaded).toBe(true);
		expect(store.size).toBe(0);
		meta.fail.delete("keys");
		await store.set("b", "value", metaOf(1));
		await store.flush();
		expect([...meta.values.keys()]).toEqual(["a"]);
	});

	it("drops the meta of a value the backend lost", async () => {
		const data = new AsyncMapBackend<string>();
		const store = new CacheStore({ meta: new AsyncMapBackend(), data });
		await store.ready;
		await store.set("a", "value", metaOf(5));
		data.values.delete("a");
		expect(await store.get("a")).toBeUndefined();
		expect(store.has("a")).toBe(false);
		expect(store.bytes).toBe(0);
	});
});

describe("CacheStore streaming", () => {
	it("sets and gets through a backend that only streams", async () => {
		const data = new StreamOnlyBackend();
		const store = new CacheStore({ meta: new AsyncMapBackend(), data });
		await store.ready;
		await store.set("a", new Uint8Array([1, 2, 3]), metaOf(3));
		expect(await store.get("a")).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("streams into a backend that only sets, sizing the meta by the bytes", async () => {
		const store = new CacheStore({ meta: new AsyncMapBackend(), data: new AsyncMapBackend<Uint8Array>() });
		await store.ready;
		const meta = metaOf();
		expect(await store.setStream("a", bytesStream(new Uint8Array(10)), meta)).toBe(10);
		expect(meta.bytes).toBe(10);
		expect(store.dataBytes).toBe(10);
	});

	it("rejects a stream over maxValueBytes and holds nothing", async () => {
		const data = new StreamOnlyBackend();
		const store = new CacheStore({ meta: new AsyncMapBackend(), data, maxValueBytes: 4 });
		await store.ready;
		await expect(store.setStream("a", bytesStream(new Uint8Array(10), 0, 10, 2), metaOf())).rejects.toThrow("over the 4 bytes");
		expect(store.has("a")).toBe(false);
		expect(data.values.has("a")).toBe(false);
	});

	it("adopts a value the backend holds, asking it for the bytes", async () => {
		const data = new StreamOnlyBackend();
		const store = new CacheStore({ meta: new AsyncMapBackend(), data });
		await store.ready;
		data.values.set("a", new Uint8Array(7));
		await store.adopt("a", metaOf());
		expect(store.meta("a")?.bytes).toBe(7);
		await expect(store.adopt("missing", metaOf())).rejects.toThrow("missing is not in the streamOnly backend");
	});
});
