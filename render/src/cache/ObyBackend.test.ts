import { store as obyStore } from "oby";
import { expect, test, vi } from "vitest";

import { Cache, CacheStore, MapBackend } from "../../../cache";
import { backendContract } from "../../../test/backendContract";
import { ObyBackend } from "./ObyBackend";

backendContract("ObyBackend", { make: () => new ObyBackend<object>(), value: (n) => ({ n }) });

test("one oby store per key, readers' changes are reported", async () => {
	const onChange = vi.fn();
	const backend = new ObyBackend<{ n: number }>(onChange);
	backend.set("k", { n: 1 });
	const store = backend.get("k")!;
	backend.set("k", { n: 2 });
	expect(backend.get("k")).toBe(store);
	expect(store.n).toBe(2);
	onChange.mockClear();
	store.n = 3;
	// oby notifies asynchronously
	await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith("k", store));
});

test("a deleted key's oby store gets its next value, readers keep one store", () => {
	const backend = new ObyBackend<{ n: number }>();
	backend.set("k", { n: 1 });
	const store = backend.get("k")!;
	backend.del("k");
	expect(backend.get("k")).toBeUndefined();
	backend.set("k", { n: 2 });
	expect(backend.get("k")).toBe(store);
	expect(store.n).toBe(2);
	expect(obyStore.unwrap(store)).toEqual({ n: 2 });
});

test("a Cache over it hands out the oby store", async () => {
	const cache = Cache.from("oby-backend-test", () => ({
		memory: new CacheStore({ meta: new MapBackend(), data: new ObyBackend<{ n: number }>() }),
	}));
	await cache.set("k", { n: 1 });
	const store = cache.get("k")!;
	await cache.set("k", { n: 2 });
	expect(cache.get("k")).toBe(store);
	expect(store.n).toBe(2);
});
