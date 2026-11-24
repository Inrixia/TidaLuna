import { expect, test } from "vitest";

import { Cache, CacheStore, MapBackend } from "../../../cache";
import { backendContract } from "../../../test/backendContract";
import { ReactiveStore } from "../ReactiveStore";
import { ReactiveStoreBackend } from "./ReactiveStoreBackend";

let n = 0;
/** A backend over an IndexedDB store of its own */
const make = <V>() => new ReactiveStoreBackend<V>(ReactiveStore.getStore(`backend-test-${n++}`));

backendContract("ReactiveStoreBackend", { make: () => make<{ n: number }>(), value: (n) => ({ n }) });

test("stats say where the values are and count them", async () => {
	const backend = make<string>();
	await backend.set("a", "x");
	expect(backend.stats()).toMatchObject({ kind: "indexedDB", entries: 1, writes: 1, location: expect.stringContaining("backend-test-") });
	expect([...(await backend.entries())]).toEqual([["a", "x"]]);
});

test("a cache made again over the same stores loads what the first persisted", async () => {
	const meta = make<any>();
	const data = make<string>();
	const first = Cache.from("rsb-first", () => ({
		memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<string>() }),
		persist: new CacheStore({ meta, data }),
	}));
	await first.set("k", "value");
	await first.flush();

	const second = Cache.from("rsb-second", () => ({
		memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<string>() }),
		persist: new CacheStore({ meta, data }),
	}));
	expect(await second.read("k")).toBe("value");
});
