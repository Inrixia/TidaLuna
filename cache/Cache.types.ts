import type { AddReceiver, MaybePromise } from "@inrixia/helpers";

import type { BackendStats } from "./CacheStoreBackend";

/**
 * An entry as eviction and the backends see it, without its value. Each store keeps one per key in its meta backend.
 * `X` is what the entry's data backend needs besides, e.g. `FsBackend`'s `path`
 */
export type CacheMeta<X = unknown> = {
	/** Bytes the value takes in the store holding this meta: estimated memory in a memory store, serialized or file bytes in a persisting one */
	bytes: number;
	/** Read score as of `last`, see Cache.lrfu.ts */
	crf: number;
	/** When it was last read, ms since epoch */
	last: number;
	/** When its value was written, or last found unchanged by `revalidate`, ms since epoch */
	written: number;
	/** Dropped this long after `written` */
	maxAgeMs?: number;
	/** Read this long after `written`, it is revalidated in the background (see `CacheHooks.revalidate`) */
	revalidateAfterMs?: number;
} & X;

/** What a cache keeps in its persist meta backend under `CacheStore.settingsKey` */
export type CacheSettings = { userBytesLimit?: number };

/**
 * How `set` writes to the persist store:
 * - `sync`: resolves once the value is persisted, its meta is saved with the next batch (`saveDelayMs`)
 * - `async`: resolves once it is in memory, persisted in the background (a failure is logged)
 * - `atomic`: the value and its meta are both persisted before either is visible, readers see the old value until then
 */
export type CacheWriteMode = "sync" | "async" | "atomic";

export type CacheSetOptions<X> = {
	/** What the data backends need besides the value, e.g. `{ path }` for `FsBackend` */
	meta?: X;
	/** This entry's max age instead of the cache's */
	maxAgeMs?: number;
	/** This entry's `revalidateAfterMs` instead of the cache's */
	revalidateAfterMs?: number;
	/** This write's mode instead of the cache's */
	write?: CacheWriteMode;
};

export type CacheOptions<MemS, PersistS> = {
	/** What the cache holds, for the UI */
	desc?: string;
	/** Holds the values read most recently, and every value when there is no `persist` */
	memory: MemS;
	/** Keeps values beyond memory and across restarts. Without it the cache is memory only */
	persist?: PersistS;
	/** How `set` writes to `persist`, `sync` by default. `set` can choose per call */
	write?: CacheWriteMode;
	/** Time for an entry's read score to halve, 7 days by default */
	halfLifeMs?: number;
	/** Entries older than this are dropped, `Infinity` by default. `set` can give an entry its own */
	maxAgeMs?: number;
	/** Values read this long after they were written are revalidated, never by default. `set` can give an entry its own */
	revalidateAfterMs?: number;
};

/** A store's counters and sizes for the UI */
export type StoreStats = {
	entries: number;
	/** Bytes of the metas held */
	metaBytes: number;
	/** Bytes of the values held */
	dataBytes: number;
	/** Bytes it may hold */
	bytesLimit: number;
	hits: number;
	misses: number;
	evictions: number;
	/** Bytes of reads, as given by the readers */
	readBytes: number;
	/** Bytes of new and replaced values */
	writtenBytes: number;
	meta: BackendStats;
	data: BackendStats;
};

/** A snapshot of a cache for the UI, structured clonable so it can cross from the main process */
export type CacheStats = {
	key: string;
	/** See `CacheOptions.desc` */
	desc?: string;
	entries: number;
	/** Bytes held, in the persist store when there is one */
	bytes: number;
	/** What the user set, `undefined` for the store's default */
	userBytesLimit?: number;
	/** Bytes the cache may hold now: the user's limit or the default, capped by `CacheHooks.maxBytesLimit` */
	bytesLimit: number;
	/** The cap from `CacheHooks.maxBytesLimit`, `Infinity` without one */
	maxBytesLimit: number;
	/** Background revalidations run, see `CacheHooks.revalidate` */
	revalidations: number;
	memory: StoreStats;
	persist?: StoreStats;
	/** What the cache's hooks count, see `CacheHooks.stats`. The UI formats keys ending in `Bytes` as bytes */
	extra?: Record<string, number>;
};

/** What the UI works a cache through, implemented by `Cache` and by proxies of caches in the main process (lib `NativeCache`) */
export interface CacheControl {
	readonly key: string;
	stats(): MaybePromise<CacheStats>;
	/** Calls back with the stats whenever they change, at most twice a second */
	onStats: AddReceiver<CacheStats>;
	/** Bytes the cache may hold, `undefined` for the default. Kept across restarts, evicts what no longer fits */
	setUserBytesLimit(bytes?: number): Promise<void>;
	/** Deletes every entry that isn't pinned */
	clear(): Promise<void>;
	/** Opens where the values are, if they are in a folder */
	openLocation?(): Promise<unknown>;
}
