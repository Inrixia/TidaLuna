// The behaviour every CacheStoreBackend shares, run against each backend from its own test file: `backendContract("FsBackend", { ... })`
import type { MaybePromise } from "@inrixia/helpers";
import { describe, expect, it } from "vitest";

import type { CacheMeta } from "../cache/Cache.types";
import type { CacheStoreBackendBase } from "../cache/CacheStoreBackend";
import { bytesStream, readAll } from "../cache/streams";

export type BackendContractOptions<V, X> = {
	/** A new, empty backend for each test */
	make: () => MaybePromise<CacheStoreBackendBase<V, X, boolean>>;
	/** A distinct value per `n` */
	value: (n: number) => V;
	/** The meta the backend gets with `key`, e.g. FsBackend's `path` */
	meta?: (key: string) => X;
};

const metaOf = <X>(options: BackendContractOptions<unknown, X>, key: string): CacheMeta<X> => {
	const now = Date.now();
	return <CacheMeta<X>>{ ...options.meta?.(key), bytes: 0, crf: 1, last: now, written: now };
};
/** Writes by `set`, or `setStream` for a backend without it */
const write = async <V, X>(backend: CacheStoreBackendBase<V, X, boolean>, key: string, value: V, meta: CacheMeta<X>) => {
	if (backend.set !== undefined) return void (await backend.set(key, value, meta));
	await backend.setStream!(key, bytesStream(<Uint8Array>value), meta);
};
/** Reads by `get`, or `getStream` for a backend without it */
const read = async <V, X>(backend: CacheStoreBackendBase<V, X, boolean>, key: string, meta: CacheMeta<X>): Promise<V | undefined> => {
	if (backend.get !== undefined) return backend.get(key, meta);
	const stream = await backend.getStream!(key, meta);
	return stream && <V>await readAll(stream);
};

export const backendContract = <V, X = unknown>(name: string, options: BackendContractOptions<V, X>) => {
	describe(`${name} backend contract`, () => {
		it("reads back what it wrote", async () => {
			const backend = await options.make();
			const meta = metaOf(options, "a");
			await write(backend, "a", options.value(1), meta);
			expect(await read(backend, "a", meta)).toEqual(options.value(1));
		});

		it("replaces a value written again", async () => {
			const backend = await options.make();
			const meta = metaOf(options, "a");
			await write(backend, "a", options.value(1), meta);
			await write(backend, "a", options.value(2), meta);
			expect(await read(backend, "a", meta)).toEqual(options.value(2));
		});

		it("gives undefined for a key it doesn't hold", async () => {
			const backend = await options.make();
			expect(await read(backend, "missing", metaOf(options, "missing"))).toBeUndefined();
		});

		it("deletes a value, and deleting a missing key is fine", async () => {
			const backend = await options.make();
			const meta = metaOf(options, "a");
			await write(backend, "a", options.value(1), meta);
			await backend.del("a", meta);
			expect(await read(backend, "a", meta)).toBeUndefined();
			await backend.del("missing", metaOf(options, "missing"));
		});

		it("lists the keys it holds", async (ctx) => {
			const backend = await options.make();
			if (backend.keys === undefined) return ctx.skip();
			await write(backend, "a", options.value(1), metaOf(options, "a"));
			await write(backend, "b", options.value(2), metaOf(options, "b"));
			await backend.del("a", metaOf(options, "a"));
			expect([...(await backend.keys())]).toEqual(["b"]);
		});

		it("returns values rather than promises when sync", async (ctx) => {
			const backend = await options.make();
			if (!backend.sync) return ctx.skip();
			const meta = metaOf(options, "a");
			expect(backend.set?.("a", options.value(1), meta)).not.toBeInstanceOf(Promise);
			if (backend.set === undefined) await write(backend, "a", options.value(1), meta);
			expect(backend.get?.("a", meta)).not.toBeInstanceOf(Promise);
			expect(backend.getStream?.("a", meta)).not.toBeInstanceOf(Promise);
			expect(backend.del("a", meta)).not.toBeInstanceOf(Promise);
		});

		it("streams the inclusive range asked for", async (ctx) => {
			const backend = await options.make();
			const value = options.value(1);
			if (backend.getStream === undefined || !(value instanceof Uint8Array)) return ctx.skip();
			const meta = metaOf(options, "a");
			await write(backend, "a", value, meta);
			const stream = await backend.getStream("a", meta, { start: 1, end: 2 });
			expect(await readAll(stream!)).toEqual(value.subarray(1, 3));
		});

		it("writes nothing from a stream that fails", async (ctx) => {
			const backend = await options.make();
			if (backend.setStream === undefined) return ctx.skip();
			const meta = metaOf(options, "a");
			const failing = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]));
					controller.error(new Error("source failed"));
				},
			});
			await expect(backend.setStream("a", failing, meta)).rejects.toThrow("source failed");
			expect(await read(backend, "a", meta)).toBeUndefined();
			if (backend.keys !== undefined) expect([...(await backend.keys())]).toEqual([]);
		});

		it("counts its entries in its stats", async () => {
			const backend = await options.make();
			await write(backend, "a", options.value(1), metaOf(options, "a"));
			const stats = backend.stats();
			expect(stats.kind).not.toBe("");
			expect(stats.entries).toBe(1);
		});
	});
};
