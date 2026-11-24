import { beforeEach, describe, expect, test, vi } from "vitest";
import { ReactiveStore } from "./ReactiveStore";

/**
 * ReactiveStore reaches IndexedDB only through idb-keyval, so wrapping its `get`/`set` is how a test counts reads and
 * keeps a single write in flight. Everything else is the real thing on top of fake-indexeddb (test/setup-dom.ts).
 */
const idb = vi.hoisted(() => ({
	/** Keys passed to the real `get`, in call order */
	getCalls: [] as string[],
	/** Awaited before the real read, so a test can hold one pending */
	beforeGet: undefined as (() => Promise<void>) | undefined,
	/** Awaited before the real write, so a test can hold one pending */
	beforeSet: undefined as (() => Promise<void>) | undefined,
	failSet: undefined as Error | undefined,
}));

vi.mock("idb-keyval", async (importOriginal) => {
	const actual = await importOriginal<typeof import("idb-keyval")>();
	return {
		createStore: actual.createStore,
		del: actual.del,
		keys: actual.keys,
		get: async (key: string, store: any) => {
			idb.getCalls.push(key);
			await idb.beforeGet?.();
			return actual.get(key, store);
		},
		set: async (key: string, value: unknown, store: any) => {
			if (idb.failSet !== undefined) throw idb.failSet;
			await idb.beforeSet?.();
			return actual.set(key, value, store);
		},
	};
});

// The trace logs failed writes with console.error, which the failure test below provokes on purpose
vi.hoisted(() => vi.spyOn(console, "error").mockImplementation(() => {}));

let storeId = 0;
/** A fresh idb store per test, so no test can see another's keys */
const newStore = () => ReactiveStore.getStore(`test-store-${++storeId}`);

let pluginId = 0;
const newPluginName = () => `test-plugin-${++pluginId}`;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ReactiveStore", () => {
	beforeEach(() => {
		idb.getCalls.length = 0;
		idb.beforeGet = undefined;
		idb.beforeSet = undefined;
		idb.failSet = undefined;
	});

	test("getStore hands out one instance per name", () => {
		const store = newStore();
		expect(store.idbName).toBe(`test-store-${storeId}`);
		expect(ReactiveStore.getStore(store.idbName)).toBe(store);
		expect(newStore()).not.toBe(store);
	});

	test("getReactive returns the same reactive object on repeat calls, reading idb once", async () => {
		const store = newStore();

		const first = await store.getReactive("key", { a: 1 });
		const second = await store.getReactive("key", { a: 2 });

		expect(second).toBe(first);
		// The cached object wins, the second default is never applied
		expect(first.a).toBe(1);
		expect(idb.getCalls).toEqual(["key"]);
	});

	test("callers that arrive before the first load finishes share its object and its read", async () => {
		const store = newStore();
		let release!: () => void;
		idb.beforeGet = () => new Promise<void>((resolve) => (release = resolve));

		const first = store.getReactive("shared", { a: 1 });
		const second = store.getReactive("shared", { a: 1 });
		release();
		const [a, b] = await Promise.all([first, second]);

		expect(b).toBe(a);
		expect(idb.getCalls).toEqual(["shared"]);
	});

	test("a key that was never stored gets the default object", async () => {
		const store = newStore();

		const reactive = await store.getReactive("fresh", { a: 1, nested: { b: 2 } });

		expect(reactive.a).toBe(1);
		expect(reactive.nested.b).toBe(2);
		expect(idb.getCalls).toEqual(["fresh"]);
	});

	test("a stored value is reconciled over the default, so the stored shape wins", async () => {
		const store = newStore();
		await store.set("stored", { a: 5 });

		const reactive = await store.getReactive("stored", { a: 1, b: 2 });

		expect(reactive.a).toBe(5);
		// Reconcile drops the default's keys that the stored value doesn't have
		expect("b" in reactive).toBe(false);
	});

	test("set reconciles an object that is already reactive", async () => {
		const store = newStore();
		const reactive = await store.getReactive("key", { a: 1, b: 2 });

		const returned = await store.set("key", { a: 9, b: 8 });

		expect(returned).toEqual({ a: 9, b: 8 });
		expect(reactive.a).toBe(9);
		expect(reactive.b).toBe(8);
		expect(await store.get("key")).toEqual({ a: 9, b: 8 });
	});

	test("set on a key that was never read only writes idb", async () => {
		const store = newStore();

		await expect(store.set("plain", { x: 1 })).resolves.toEqual({ x: 1 });

		expect(await store.get("plain")).toEqual({ x: 1 });
	});

	test("a failed write rejects and leaves the cached object as it was", async () => {
		const store = newStore();
		const reactive = await store.getReactive("key", { a: 1 });
		idb.failSet = new Error("idb unavailable");

		await expect(store.set("key", { a: 2 })).rejects.toThrow("idb unavailable");

		expect(reactive.a).toBe(1);
	});

	test("ensure returns the stored value instead of writing the default", async () => {
		const store = newStore();
		await store.set("key", "stored");

		await expect(store.ensure("key", "default")).resolves.toBe("stored");

		expect(await store.get("key")).toBe("stored");
	});

	test("ensure writes a sync default and returns it", async () => {
		const store = newStore();

		await expect(store.ensure("key", { a: 1 })).resolves.toEqual({ a: 1 });

		await vi.waitFor(async () => expect(await store.get("key")).toEqual({ a: 1 }));
	});

	test("ensure awaits an async default", async () => {
		const store = newStore();
		const defaultValue = vi.fn(async () => "async default");

		await expect(store.ensure("key", defaultValue)).resolves.toBe("async default");

		expect(defaultValue).toHaveBeenCalledTimes(1);
		await vi.waitFor(async () => expect(await store.get("key")).toBe("async default"));
	});

	test("ensure resolves without the write unless awaitSet is set", async () => {
		const store = newStore();
		let releaseWrite!: () => void;
		idb.beforeSet = () => new Promise<void>((resolve) => (releaseWrite = resolve));

		const notAwaited = store.ensure("not-awaited", "value");

		// The write is stuck, but ensure without awaitSet doesn't care
		await expect(notAwaited).resolves.toBe("value");
		expect(await store.get("not-awaited")).toBeUndefined();

		releaseWrite();
		await vi.waitFor(async () => expect(await store.get("not-awaited")).toBe("value"));
	});

	test("del, keys, dump and clear work off idb", async () => {
		const store = newStore();
		await store.set("a", 1);
		await store.set("b", { x: 2 });

		expect((await store.keys()).sort()).toEqual(["a", "b"]);
		await expect(store.dump()).resolves.toEqual({ a: 1, b: { x: 2 } });

		await store.del("a");
		expect(await store.keys()).toEqual(["b"]);
		await expect(store.dump()).resolves.toEqual({ b: { x: 2 } });

		await store.clear();
		expect(await store.keys()).toEqual([]);
		await expect(store.dump()).resolves.toEqual({});
	});

	test("getPluginStorage fills in only the default keys the stored object is missing", async () => {
		const pluginName = newPluginName();
		type PluginSettings = { a?: number; b?: number; c?: number };

		const first = await ReactiveStore.getPluginStorage<PluginSettings>(pluginName, { a: 1, b: 2 });
		const second = await ReactiveStore.getPluginStorage<PluginSettings>(pluginName, { b: 9, c: 3 });

		expect(second).toBe(first);
		expect(second.a).toBe(1);
		// Already set, so the new default doesn't overwrite it
		expect(second.b).toBe(2);
		// Missing, so the default is filled in
		expect(second.c).toBe(3);
	});

	test("getPluginStorage leaves a stored value alone", async () => {
		const pluginName = newPluginName();
		await ReactiveStore.getStore("@luna/pluginStorage").set(pluginName, { enabled: false });

		const storage = await ReactiveStore.getPluginStorage(pluginName, { enabled: true });

		expect(storage.enabled).toBe(false);
	});

	test("delete removes the key even with a write for it still in flight", async () => {
		const store = newStore();
		const reactive = await store.getReactive("key", { a: 1 });

		// Hold the write a change queues, the way a change made just before an uninstall's delete is held
		let releaseWrite: () => void = () => {};
		idb.beforeSet = () => new Promise<void>((resolve) => (releaseWrite = resolve));
		reactive.a = 2;

		const deleted = store.delete("key");
		idb.beforeSet = undefined;
		releaseWrite();
		await deleted;

		// The held write landed first and the delete won: the key is gone, not restored by it
		await expect(store.get("key")).resolves.toBeUndefined();
		// And the object is no longer cached, so a later read starts from the store again
		expect((await store.getReactive("key", { a: 3 })).a).toBe(3);
	});
});
