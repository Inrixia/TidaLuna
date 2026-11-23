import { cacheClear, cacheOpenFolder, cacheSetLimit, cacheStats, type DiskCacheStats } from "../../../lib.native/src/index.native";

import { ReactiveStore, type LunaUnloads } from "@luna/core";

import * as ipc from "../ipc";
import { libTrace } from "../index.safe";

export type { DiskCacheStats };

/**
 * A cache kept on disk by the main process (native/cache/DiskCache.ts), which holds the entries, evicts the least recently and frequently
 * used when over its limit and counts the stats. This is the renderer side every cache provider (`AudioCache`, `OfflineCache`) builds on,
 * and what the cache UI works through: the stats and their updates, the user's limit (kept across restarts), the folder, clearing.
 */
export class Cache {
	/** Every cache, by name */
	public static readonly all = new Map<string, Cache>();

	protected readonly trace;
	/** 0 for the default */
	private readonly storage: Promise<{ limitBytes: number }>;

	/**
	 * @param name The name the main process knows the cache by
	 * @param storageName Where the user's limit is kept
	 */
	public constructor(
		public readonly name: string,
		storageName: string,
	) {
		this.trace = libTrace.withSource(`${name}Cache`).trace;
		Cache.all.set(name, this);
		this.storage = ReactiveStore.getPluginStorage(storageName, { limitBytes: 0 });
		this.storage.then(({ limitBytes }) => (limitBytes ? cacheSetLimit(name, limitBytes) : undefined)).catch(this.trace.err.withContext("limit"));
	}

	public stats(): Promise<DiskCacheStats> {
		return cacheStats(this.name);
	}
	/** Calls `listener` with the stats now and whenever they change (at most once a second). Returns the unsubscribe */
	public onStats(unloads: LunaUnloads, listener: (stats: DiskCacheStats) => void): () => void {
		const unload = ipc.on(unloads, "__Luna.cacheStats", (stats: DiskCacheStats) => stats.name === this.name && listener(stats));
		this.stats().then(listener, this.trace.err.withContext("stats"));
		return unload;
	}

	/** Bytes the cache may use, kept across restarts. 0 for its default. Resolves once what no longer fits is deleted */
	public async setLimit(bytes: number): Promise<void> {
		(await this.storage).limitBytes = bytes;
		return cacheSetLimit(this.name, bytes || undefined);
	}
	/** Bytes that setting the limit to `bytes` (0 for the default) deletes */
	public async evictedBy(bytes: number): Promise<number> {
		const { usage, defaultLimit } = await this.stats();
		return Math.max(0, usage - (bytes || defaultLimit));
	}
	public openFolder(): Promise<string> {
		return cacheOpenFolder(this.name);
	}
	/** Deletes everything in the cache that isn't in use */
	public clear(): Promise<void> {
		return cacheClear(this.name);
	}
}
