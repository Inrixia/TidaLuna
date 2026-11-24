import type { BackendStats, CacheStoreBackendBase } from "../../../cache";
import type { ReactiveStore } from "../ReactiveStore";

/** Values (or metas) in an IndexedDB store of a `ReactiveStore`: the persist backend of page caches */
export class ReactiveStoreBackend<V = unknown> implements CacheStoreBackendBase<V, unknown, false> {
	public readonly sync = false;
	/** Keys known to be held, from the last `keys`/`entries` and every write since: the stats can't ask IndexedDB */
	private readonly known = new Set<string>();
	private reads = 0;
	private writes = 0;
	private errors = 0;

	public constructor(private readonly store: ReactiveStore) {}

	/** Counts a failure of `op` and rethrows it */
	private async run<T>(op: () => Promise<T>): Promise<T> {
		try {
			return await op();
		} catch (err) {
			this.errors++;
			throw err;
		}
	}

	public get(key: string): Promise<V | undefined> {
		this.reads++;
		return this.run(() => this.store.get<V>(key));
	}
	public async set(key: string, data: V): Promise<void> {
		this.writes++;
		await this.run(() => this.store.set(key, data));
		this.known.add(key);
	}
	public async del(key: string): Promise<void> {
		await this.run(() => this.store.del(key));
		this.known.delete(key);
	}
	public async keys(): Promise<string[]> {
		const keys = await this.run(() => this.store.keys());
		this.known.clear();
		for (const key of keys) this.known.add(key);
		return keys;
	}
	/** Every key and value in one transaction, instead of one read per key */
	public async entries(): Promise<[string, V][]> {
		const entries = await this.run(() => this.store.entries<V>());
		this.known.clear();
		for (const [key] of entries) this.known.add(key);
		return entries;
	}
	public stats(): BackendStats {
		return {
			kind: "indexedDB",
			entries: this.known.size,
			reads: this.reads,
			writes: this.writes,
			errors: this.errors,
			location: this.store.idbName,
		};
	}
}
