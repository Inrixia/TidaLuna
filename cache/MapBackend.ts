import type { BackendStats, CacheStoreBackendBase } from "./CacheStoreBackend";
import { estimateMemory } from "./estimateMemory";

/** Values (or metas) in a Map, sized by the memory they take. The memory backend of most caches */
export class MapBackend<V = unknown> implements CacheStoreBackendBase<V, unknown, true> {
	public readonly sync = true;
	private readonly values = new Map<string, V>();
	private reads = 0;
	private writes = 0;

	public get(key: string): V | undefined {
		this.reads++;
		return this.values.get(key);
	}
	public set(key: string, data: V): void {
		this.writes++;
		this.values.set(key, data);
	}
	public del(key: string): void {
		this.values.delete(key);
	}
	public keys(): Iterable<string> {
		return this.values.keys();
	}
	public entries(): Iterable<[string, V]> {
		return this.values.entries();
	}
	public sizeOf(data: V): number {
		return estimateMemory(data);
	}
	public stats(): BackendStats {
		return { kind: "map", entries: this.values.size, reads: this.reads, writes: this.writes, errors: 0 };
	}
}
