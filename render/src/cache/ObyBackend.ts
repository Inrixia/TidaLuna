import { isStore, store as obyStore } from "oby";

import type { BackendStats, CacheStoreBackendBase } from "../../../cache";
import { estimateMemory, WeakRefs } from "../../../cache";

/**
 * Memory values handed out as oby stores, so readers track them and a `Cache` over it is reactive. One oby store per key stays for the session
 * so every reader shares it: a deleted key's store gets its next value (reconciled into it), rather than a second store appearing.
 * Values that aren't objects are held as they are
 */
export class ObyBackend<V> implements CacheStoreBackendBase<V, unknown, true> {
	public readonly sync = true;
	/** The oby store of each object value, kept after a delete while a reader still holds it */
	private readonly stores = new WeakRefs<object>();
	/** The values held now: oby stores of objects, other values as they are */
	private readonly values = new Map<string, V>();
	private reads = 0;
	private writes = 0;

	/** @param onChange called with the oby store of a value whenever a reader changes it, e.g. to write it back to the cache's persist store */
	public constructor(private readonly onChange?: (key: string, store: V) => void) {}

	public get(key: string): V | undefined {
		this.reads++;
		return this.values.get(key);
	}
	/** Holds `data`, reconciled into the key's oby store if it has one. Readers get the oby store of an object */
	public set(key: string, data: V): void {
		this.writes++;
		if (typeof data !== "object" || data === null) {
			this.values.set(key, data);
			return;
		}
		const held = this.stores.get(key);
		if (held !== undefined) {
			obyStore.reconcile(held, <object>data);
			return void this.values.set(key, <V>held);
		}
		const store = <V>obyStore(data);
		obyStore.on(<object>store, () => this.onChange?.(key, store));
		this.stores.set(key, <object>store);
		this.values.set(key, store);
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
		return estimateMemory(isStore(data) ? obyStore.unwrap(data) : data);
	}
	public stats(): BackendStats {
		return { kind: "oby", entries: this.values.size, reads: this.reads, writes: this.writes, errors: 0 };
	}
}
