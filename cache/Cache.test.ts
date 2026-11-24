import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { AsyncMapBackend } from "test/AsyncMapBackend";
import { StreamOnlyBackend } from "test/StreamOnlyBackend";
import { Cache } from "./Cache";
import type { CacheHooks } from "./Cache.hooks";
import { CacheStore } from "./CacheStore";
import { MapBackend } from "./MapBackend";
import { bytesStream, readAll } from "./streams";
import { StreamBufferBackend } from "./StreamBufferBackend";

let caches = 0;
/** Caches live for the runtime by key, so each test makes its own */
const newKey = () => `test${caches++}`;
const unloadsOf = () => new Set<() => void>();
const unload = (unloads: Set<() => void>) => {
	for (const fn of unloads) fn();
};
/** Every value takes 1000 bytes, metas a few hundred more: 2 entries fit in 2500 bytes, a 3rd evicts one */
const kiloBytes: CacheHooks<any, any> = { sizeOf: () => 1000 };

const memoryCache = (bytesLimit?: number) =>
	Cache.from(newKey(), () => ({ memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<string>(), bytesLimit }) }));

const tieredCache = (limits: { memory?: number; persist?: number } = {}) => {
	const persistMeta = new AsyncMapBackend();
	const persistData = new AsyncMapBackend<string>();
	const key = newKey();
	const cache = Cache.from(key, () => ({
		memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<string>(), bytesLimit: limits.memory }),
		persist: new CacheStore({ meta: persistMeta, data: persistData, bytesLimit: limits.persist }),
	}));
	return { cache, persistMeta, persistData, key };
};

const streamCache = (memoryMaxValueBytes?: number) => {
	const persistData = new StreamOnlyBackend();
	const cache = Cache.from(newKey(), () => ({
		memory: new CacheStore({ meta: new MapBackend(), data: new StreamBufferBackend(), maxValueBytes: memoryMaxValueBytes }),
		persist: new CacheStore({ meta: new AsyncMapBackend(), data: persistData }),
	}));
	return { cache, persistData };
};

/** A stream whose chunks the test pushes */
const pushedStream = () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
	return { stream, controller };
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("Cache.from", () => {
	it("makes a cache once per key and adds it to the controls", async () => {
		const added: string[] = [];
		Cache.onControlAdded(unloadsOf(), (control) => void added.push(control.key));
		const key = newKey();
		const cache = Cache.from(key, () => ({ memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend() }) }));
		expect(Cache.from(key, () => expect.unreachable())).toBe(cache);
		expect(Cache.caches.get(key)).toBe(cache);
		expect(Cache.controls.get(key)).toBe(cache);
		await vi.waitFor(() => expect(added).toContain(key));
	});
});

describe("Cache in memory", () => {
	it("gets synchronously, and peek doesn't count a read", () => {
		const cache = memoryCache();
		void cache.set("a", "value");
		expect(cache.get("a")).toBe("value");
		expect(cache.peek("a")).toBe("value");
		expect(cache.memoryStore.hits).toBe(1);
		expect(cache.get("missing")).toBeUndefined();
		expect(cache.has("a")).toBe(true);
		expect(cache.status("a")).toBe("complete");
	});

	it("evicts the lowest ranked entry over its limit, keeping the one just written", async () => {
		const cache = memoryCache(2500);
		cache.attach(kiloBytes, unloadsOf());
		await cache.set("a", "a");
		await cache.set("b", "b");
		cache.get("a");
		cache.get("a");
		await cache.set("c", "c");
		expect([...cache.keys()].sort()).toEqual(["a", "c"]);
		expect(cache.memoryStore.evictions).toBe(1);
	});

	it("drops entries past their max age", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const cache = memoryCache();
		await cache.set("a", "value", { maxAgeMs: 1000 });
		vi.setSystemTime(Date.now() + 1000);
		expect(cache.has("a")).toBe(false);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it("deletes a value only if it is still the one given", async () => {
		const cache = memoryCache();
		await cache.set("a", "x");
		expect(await cache.delete("a", "y")).toBe(false);
		expect(await cache.delete("a", "x")).toBe(true);
		expect(await cache.delete("a")).toBe(false);
	});

	it("sizes a promise once it settles, and drops it if it rejects", async () => {
		const cache = Cache.from(newKey(), () => ({ memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<Promise<string>>() }) }));
		await cache.set("a", Promise.resolve("abcdef"));
		await vi.waitFor(() => expect(cache.memoryStore.meta("a")?.bytes).toBe(new MapBackend().sizeOf("abcdef")));
		await cache.set("b", Promise.reject(new Error("failed")));
		await vi.waitFor(() => expect(cache.has("b")).toBe(false));
	});
});

describe("Cache tiers", () => {
	it("reads from persist when memory doesn't hold it, and promotes it", async () => {
		const { cache } = tieredCache({ memory: 2500 });
		cache.attach(kiloBytes, unloadsOf());
		await cache.set("a", "a");
		await cache.set("b", "b");
		await cache.set("c", "c");
		// Memory only demotes: every entry is still held
		expect(cache.size).toBe(3);
		expect(cache.memoryStore.size).toBe(2);
		const demoted = ["a", "b", "c"].find((key) => cache.peek(key) === undefined)!;
		expect(cache.has(demoted)).toBe(true);
		expect(await cache.read(demoted)).toBe(demoted);
		expect(cache.peek(demoted)).toBe(demoted);
		expect(cache.memoryStore.size).toBe(2);
	});

	it("evicting from persist removes the entry from every store", async () => {
		const { cache, persistData } = tieredCache({ persist: 2500 });
		cache.attach(kiloBytes, unloadsOf());
		await cache.set("a", "a");
		await cache.set("b", "b");
		await cache.set("c", "c");
		expect(cache.size).toBe(2);
		expect(cache.memoryStore.size).toBe(2);
		expect(persistData.values.size).toBe(2);
		expect(cache.persistStore.evictions).toBe(1);
	});

	it("loads what was persisted by a cache before it", async () => {
		const { cache, persistMeta, persistData } = tieredCache();
		await cache.set("a", "value");
		await cache.setUserBytesLimit(5000);
		await cache.flush();
		const reopened = Cache.from(newKey(), () => ({
			memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<string>() }),
			persist: new CacheStore({ meta: persistMeta, data: persistData }),
		}));
		await reopened.ready;
		expect(reopened.userBytesLimit).toBe(5000);
		expect(reopened.bytesLimit).toBe(5000);
		expect(reopened.has("a")).toBe(true);
		expect(await reopened.read("a")).toBe("value");
	});

	it("rejects a sync write the persist store fails, logs an async one", async () => {
		const { cache, persistData } = tieredCache();
		await cache.ready;
		persistData.fail.add("set");
		await expect(cache.set("a", "value")).rejects.toThrow("set failed");
		await cache.set("b", "value", { write: "async" });
		expect(cache.peek("b")).toBe("value");
		expect(cache.persistStore.has("b")).toBe(false);
	});

	it("persists value and meta before an atomic write resolves", async () => {
		const { cache, persistMeta, persistData } = tieredCache();
		await cache.set("a", "value", { write: "atomic" });
		expect(persistData.values.get("a")).toBe("value");
		expect(persistMeta.values.has("a")).toBe(true);
		expect(cache.peek("a")).toBe("value");
	});

	it("touch counts a read without reading the value", async () => {
		const { cache, persistData } = tieredCache();
		await cache.set("a", "value");
		const crf = cache.meta("a")!.crf;
		const get = vi.spyOn(persistData, "get");
		expect(cache.touch("a")).toBe(true);
		expect(cache.meta("a")!.crf).toBeGreaterThan(crf);
		expect(cache.memoryStore.meta("a")!.crf).toBe(cache.meta("a")!.crf);
		expect(get).not.toHaveBeenCalled();
		expect(cache.touch("missing")).toBe(false);
	});

	it("clears every store", async () => {
		const { cache, persistData } = tieredCache();
		await cache.set("a", "value");
		await cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.peek("a")).toBeUndefined();
		expect(persistData.values.size).toBe(0);
	});
});

describe("Cache hooks", () => {
	it("revalidates a stale value in the background", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const cache = memoryCache();
		const revalidate = vi.fn(async (_key: string, value: string) => `${value}!`);
		cache.attach({ revalidate }, unloadsOf());
		const changed: string[] = [];
		cache.onChange(unloadsOf(), (key) => void changed.push(key));
		await cache.set("a", "v", { revalidateAfterMs: 1000 });
		expect(cache.get("a")).toBe("v");
		expect(revalidate).not.toHaveBeenCalled();
		vi.setSystemTime(Date.now() + 1000);
		expect(cache.get("a")).toBe("v");
		await vi.waitFor(() => expect(cache.peek("a")).toBe("v!"));
		expect(revalidate).toHaveBeenCalledTimes(1);
		expect(cache.revalidations).toBe(1);
		await vi.waitFor(() => expect(changed).toEqual(["a"]));
	});

	it("keeps a value revalidate found unchanged, fresh again", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const cache = memoryCache();
		const revalidate = vi.fn(async () => undefined);
		cache.attach({ revalidate }, unloadsOf());
		await cache.set("a", "v", { revalidateAfterMs: 1000 });
		vi.setSystemTime(Date.now() + 1000);
		const staleAt = Date.now();
		cache.get("a");
		await vi.waitFor(() => expect(cache.meta("a")?.written).toBeGreaterThanOrEqual(staleAt));
		cache.get("a");
		expect(revalidate).toHaveBeenCalledTimes(1);
		expect(cache.peek("a")).toBe("v");
	});

	it("drops a value revalidate rejects", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const cache = memoryCache();
		cache.attach({ revalidate: () => Promise.reject(new Error("gone")) }, unloadsOf());
		await cache.set("a", "v", { revalidateAfterMs: 1000 });
		vi.setSystemTime(Date.now() + 1000);
		cache.get("a");
		await vi.waitFor(() => expect(cache.has("a")).toBe(false));
	});

	it("attaches one set of hooks at a time, until unloaded", () => {
		const cache = memoryCache();
		const unloads = unloadsOf();
		cache.attach({ maxBytesLimit: () => 100, stats: () => ({ liveBytes: 5 }) }, unloads);
		expect(() => cache.attach({}, unloadsOf())).toThrow("already has hooks attached");
		expect(cache.stats()).toMatchObject({ bytesLimit: 100, maxBytesLimit: 100, extra: { liveBytes: 5 } });
		unload(unloads);
		expect(cache.stats()).toMatchObject({ bytesLimit: Infinity, maxBytesLimit: Infinity, extra: undefined });
		cache.attach({}, unloadsOf());
	});

	it("never evicts a pinned entry", async () => {
		const cache = memoryCache(2500);
		cache.attach({ ...kiloBytes, isPinned: (key) => key === "a" }, unloadsOf());
		await cache.set("a", "a");
		await cache.set("b", "b");
		cache.get("b");
		await cache.set("c", "c");
		expect([...cache.keys()].sort()).toEqual(["a", "c"]);
		await cache.clear();
		expect([...cache.keys()]).toEqual(["a"]);
	});

	it("evicts down to a user limit, capped by maxBytesLimit", async () => {
		const cache = memoryCache();
		cache.attach({ ...kiloBytes, maxBytesLimit: () => 2500 }, unloadsOf());
		await cache.setUserBytesLimit(10_000);
		expect(cache.bytesLimit).toBe(2500);
		await cache.set("a", "a");
		await cache.set("b", "b");
		await cache.set("c", "c");
		expect(cache.size).toBe(2);
	});
});

describe("Cache streams", () => {
	it("streams a value to readers while it is streamed in, then from memory and persist", async () => {
		const { cache, persistData } = streamCache();
		const { stream, controller } = pushedStream();
		const writing = cache.setStream("a", stream);
		expect(cache.status("a")).toBe("filling");
		expect(cache.has("a")).toBe(false);
		const reading = readAll((await cache.getStream("a"))!);
		controller.enqueue(new Uint8Array([1, 2]));
		controller.enqueue(new Uint8Array([3, 4]));
		controller.close();
		await writing;
		expect(await reading).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(cache.status("a")).toBe("complete");
		expect(persistData.values.get("a")).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(await readAll((await cache.getStream("a", { start: 1, end: 2 }))!)).toEqual(new Uint8Array([2, 3]));
		expect(cache.memoryStore.meta("a")?.bytes).toBe(4);
		expect(cache.persistStore.meta("a")?.bytes).toBe(4);
	});

	it("leaves nothing behind when the stream fails", async () => {
		const { cache, persistData } = streamCache();
		const { stream, controller } = pushedStream();
		const writing = cache.setStream("a", stream);
		const reading = readAll((await cache.getStream("a"))!);
		controller.enqueue(new Uint8Array([1]));
		controller.error(new Error("source failed"));
		await expect(writing).rejects.toThrow("source failed");
		await expect(reading).rejects.toThrow("source failed");
		expect(cache.status("a")).toBeUndefined();
		expect(cache.memoryStore.size).toBe(0);
		expect(persistData.values.size).toBe(0);
	});

	it("keeps a value too large for memory in persist alone, and streams it from there", async () => {
		const { cache, persistData } = streamCache(4);
		await cache.setStream("a", bytesStream(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), 0, 8, 2));
		expect(cache.memoryStore.size).toBe(0);
		expect(persistData.values.get("a")?.byteLength).toBe(8);
		expect(await readAll((await cache.getStream("a", { start: 2, end: 4 }))!)).toEqual(new Uint8Array([2, 3, 4]));
	});
});

describe("Cache stats", () => {
	it("reports both stores and pushes changes at most every 500ms", async () => {
		const { cache } = tieredCache();
		const pushed = vi.fn();
		cache.onStats(unloadsOf(), pushed);
		await cache.set("a", "value");
		await cache.set("b", "value");
		await vi.waitFor(() => expect(pushed).toHaveBeenCalledTimes(1), { timeout: 2000 });
		const stats = cache.stats();
		expect(stats).toMatchObject({ entries: 2, revalidations: 0, memory: { entries: 2 }, persist: { entries: 2 } });
		expect(structuredClone(stats)).toEqual(stats);
	});
});

describe("Cache types", () => {
	it("reads synchronously over sync stores, and streams binary values only", () => {
		const strings = memoryCache();
		expectTypeOf(strings.get("a")).toEqualTypeOf<string | undefined>();
		// @ts-expect-error strings can't be streamed
		const _stream = () => strings.getStream("a");
		const { cache: tiered } = tieredCache();
		expectTypeOf(tiered.get("a")).toEqualTypeOf<string | undefined>();
		expectTypeOf(tiered.read("a")).toEqualTypeOf<Promise<string | undefined>>();
		const asyncMemory = Cache.from(newKey(), () => ({
			memory: new CacheStore({ meta: new AsyncMapBackend(), data: new AsyncMapBackend<string>() }),
		}));
		expectTypeOf(asyncMemory.get("a")).toEqualTypeOf<Promise<string | undefined>>();
		const inFlight = Cache.from(newKey(), () => ({
			memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<Promise<string | undefined>>() }),
		}));
		expectTypeOf(inFlight.get("a")).toEqualTypeOf<Promise<string | undefined> | undefined>();
		expectTypeOf(streamCache().cache.getStream).toBeFunction();
	});
});
