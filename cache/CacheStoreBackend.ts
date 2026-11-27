import type { MaybePromise } from "@inrixia/helpers";

import type { CacheMeta } from "./Cache.types";

/** What a backend method gives: the value itself from a sync backend, the value or a promise of it from an async one */
export type BackendOut<S extends boolean, T> = S extends true ? T : MaybePromise<T>;

/** Which bytes of a value to stream. `end` is inclusive, as in an HTTP range */
export type StreamRange = { start?: number; end?: number; signal?: AbortSignal };

/** A value being streamed into a backend now, see `StreamBufferBackend` */
export type InFlightStream = { key: string; filledBytes: number; totalBytes?: number; readers: number };

/** A backend's counters for the UI. Structured clonable so it can cross from the main process */
export type BackendStats = {
	/** What the backend is, e.g. `map`, `files`, `sqlite` */
	kind: string;
	entries: number;
	reads: number;
	writes: number;
	errors: number;
	/** Where it keeps values: a folder, a database file, an IndexedDB name */
	location?: string;
	/** Bytes of the files it wrote */
	fileBytes?: number;
	/** Bytes free on the disk it writes to */
	freeBytes?: number;
	inFlight?: InFlightStream[];
};

/** What a backend's `reconcile` found comparing the values it holds with the metas a store loaded */
export type ReconcileResult = {
	/** Keys with a meta but no value, the store drops their metas */
	missing: string[];
	/** Values without a meta (e.g. files written by someone else), the store can adopt them */
	orphans: string[];
};

/**
 * Where a `CacheStore` keeps values (its data backend) or the metas of its entries (its meta backend): a key/value store, sync or async (`S`).
 * Every method gets the entry's meta, which a backend may need (`FsBackend` reads `meta.path`) or ignore.
 * Each backend reads by `get` or `getStream` and writes by `set` or `setStream`, or both: `CacheStoreBackend` requires one of each,
 * `CacheStore` gives the other from it
 */
export interface CacheStoreBackendBase<V, X = unknown, S extends boolean = boolean> {
	/** `true` when every method returns its value rather than a promise, so a store over it (and a cache over that) reads synchronously */
	readonly sync: S;
	get?(key: string, meta?: CacheMeta<X>): BackendOut<S, V | undefined>;
	set?(key: string, data: V, meta?: CacheMeta<X>): BackendOut<S, void>;
	del(key: string, meta?: CacheMeta<X>): BackendOut<S, void>;
	keys?(): BackendOut<S, Iterable<string>>;
	/** Every key with its value at once, when the backend can do that faster than `keys` then `get` each */
	entries?(): BackendOut<S, Iterable<[string, V]>>;
	/** The value's bytes as a stream, without reading it all into memory */
	getStream?(key: string, meta?: CacheMeta<X>, range?: StreamRange): BackendOut<S, ReadableStream<Uint8Array> | undefined>;
	/** Writes the value from `dataStream`, resolves to the bytes written. A failed stream writes nothing */
	setStream?(key: string, dataStream: ReadableStream<Uint8Array>, meta?: CacheMeta<X>): Promise<number>;
	/** Called once on open with every meta loaded: drops what has no meta, says which metas lack a value and which values lack a meta */
	reconcile?(metas: ReadonlyMap<string, CacheMeta<X>>): BackendOut<S, ReconcileResult>;
	/** Bytes of a value it holds, for `CacheStore.adopt` of a value written by someone else */
	bytesOf?(key: string, meta?: CacheMeta<X>): BackendOut<S, number | undefined>;
	/** Bytes `data` takes here: estimated memory for a memory backend, serialized bytes for a persisting one. `sizeOf.ts` when missing */
	sizeOf?(data: V): MaybePromise<number>;
	/** An entry being read now, which eviction leaves alone */
	pinned?(key: string): boolean;
	stats(): BackendStats;
	/** Releases what it holds open, e.g. a database */
	close?(): void;
}

type Gets<V, X, S extends boolean> =
	Required<Pick<CacheStoreBackendBase<V, X, S>, "get">> | Required<Pick<CacheStoreBackendBase<V, X, S>, "getStream">>;
type Sets<V, X, S extends boolean> =
	Required<Pick<CacheStoreBackendBase<V, X, S>, "set">> | Required<Pick<CacheStoreBackendBase<V, X, S>, "setStream">>;

/** A backend that reads (`get` or `getStream`) and writes (`set` or `setStream`). Backends are classes implementing `CacheStoreBackendBase` */
export type CacheStoreBackend<V, X = unknown, S extends boolean = boolean> = CacheStoreBackendBase<V, X, S> & Gets<V, X, S> & Sets<V, X, S>;
export type SyncCacheStoreBackend<V, X = unknown> = CacheStoreBackend<V, X, true>;

/** What a meta backend holds: an entry's meta, or the cache's settings under `CacheStore.settingsKey` */
export type StoredMeta = CacheMeta<any> | Record<string, unknown>;
/** A backend that holds metas: it must list its keys so the store can load them all */
export type MetaBackend<S extends boolean = boolean> = CacheStoreBackendBase<any, any, S> &
	Required<Pick<CacheStoreBackendBase<StoredMeta, unknown, S>, "get" | "set" | "keys">>;
