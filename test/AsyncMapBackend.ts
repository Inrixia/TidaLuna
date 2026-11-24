import type { CacheMeta } from "../cache/Cache.types";
import type { BackendStats, CacheStoreBackendBase } from "../cache/CacheStoreBackend";

/** A Map behind promises, standing in for a persisting backend (IndexedDB, files) in tests. `fail` makes the next calls of a method reject */
export class AsyncMapBackend<V = unknown> implements CacheStoreBackendBase<V, unknown, false> {
	public readonly sync = false;
	public readonly values = new Map<string, V>();
	/** Methods that reject while named here */
	public readonly fail = new Set<"get" | "set" | "del" | "keys">();
	public writes = 0;

	private check(method: "get" | "set" | "del" | "keys") {
		if (this.fail.has(method)) throw new Error(`${method} failed`);
	}
	public async get(key: string): Promise<V | undefined> {
		this.check("get");
		return this.values.get(key);
	}
	public async set(key: string, data: V, _meta?: CacheMeta): Promise<void> {
		this.check("set");
		this.writes++;
		// Copied, as a persisting backend holds what was written rather than the caller's object
		this.values.set(key, structuredClone(data));
	}
	public async del(key: string): Promise<void> {
		this.check("del");
		this.values.delete(key);
	}
	public async keys(): Promise<Iterable<string>> {
		this.check("keys");
		return [...this.values.keys()];
	}
	public stats(): BackendStats {
		return { kind: "asyncMap", entries: this.values.size, reads: 0, writes: this.writes, errors: 0 };
	}
}
