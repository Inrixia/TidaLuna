import { sleep, type MaybePromise } from "@inrixia/helpers";

import { createLogger } from "../render/src/trace/createLogger";
import { slackOf } from "./Cache.lrfu";
import type { CacheMeta, CacheSettings, StoreStats } from "./Cache.types";
import type { CacheStoreBackendBase, MetaBackend, ReconcileResult, StreamRange } from "./CacheStoreBackend";
import { sizeOf } from "./sizeOf";
import { bytesStream, readAll, toBytes } from "./streams";
import { thenMaybe } from "./thenMaybe";

export type AnyBackend = CacheStoreBackendBase<any, any, boolean>;
/** The values a backend holds (sync matched first so `V = Promise<X>` isn't split against `MaybePromise<V>`) */
export type BackendValue<B> = B extends { readonly sync: infer S extends boolean }
	? B extends CacheStoreBackendBase<infer V, any, S>
		? V
		: never
	: never;
/** What a backend needs in a meta besides `CacheMeta`, e.g. `FsBackend`'s `path` */
export type BackendMetaX<B> = B extends CacheStoreBackendBase<any, infer X, any> ? X : never;
/** Whether both backends are sync, so the store reads and writes synchronously */
type BothSync<MB, DB> = MB extends { readonly sync: true } ? (DB extends { readonly sync: true } ? true : false) : false;

export type AnyCacheStore = CacheStore<MetaBackend, AnyBackend>;
/** What a store's method gives: the value itself from a sync store, a promise of it from an async one */
export type StoreOut<S extends AnyCacheStore, T> = S["sync"] extends true ? T : Promise<T>;

export type CacheStoreOptions<MB, DB> = {
	/** Holds the metas of the entries, loaded on open */
	meta: MB;
	/** Holds the values */
	data: DB;
	/** Bytes of values and metas the store may hold, `Infinity` by default. A cache's user limit replaces it for its persist store */
	bytesLimit?: number;
	/** Bytes eviction goes under the limit so the next writes don't each evict again, see `slackOf` for the default */
	slackBytes?: number;
	/** Delay before changed metas and settings are saved to the meta backend, 10s by default */
	saveDelayMs?: number;
	/** Values larger than this aren't held, e.g. so one track doesn't take a memory store. `Infinity` by default */
	maxValueBytes?: number;
};

/** An entry the store holds: its meta and the bytes the meta takes, measured once when it is set */
type Held<X> = { meta: CacheMeta<X>; metaBytes: number };

/**
 * A tier of a cache: a meta backend and a data backend, read meta first. It keeps every meta in memory (loaded on open) so eviction can rank
 * them, saves changed ones in batches, counts the bytes of both and fills in the read or write method a data backend lacks from the other.
 * Over sync backends its methods return values, otherwise promises. What to evict and when is the `Cache`'s call, see Cache.ts
 */
export class CacheStore<MB extends MetaBackend = MetaBackend, DB extends AnyBackend = AnyBackend> {
	/** Where the cache's settings are kept in the meta backend, a key no entry can have */
	public static readonly settingsKey = "\0settings";
	private static readonly logErr = createLogger("[CacheStore]", console.error);

	public readonly metaBackend: MB;
	public readonly dataBackend: DB;
	/** `true` when both backends are sync, see `StoreOut` */
	public readonly sync: BothSync<MB, DB>;
	public bytesLimit: number;
	public saveDelayMs: number;
	public maxValueBytes: number;
	private readonly slackBytesOption?: number;

	private readonly held = new Map<string, Held<BackendMetaX<DB>>>();
	/** The cache's settings, loaded on open. `setSettings` saves them */
	public settings: CacheSettings = {};
	/** Values the data backend holds without a meta, as its `reconcile` names them (e.g. `FsBackend` paths), for the cache's owner to adopt */
	public orphans: string[] = [];
	public dataBytes = 0;
	public metaBytes = 0;
	public hits = 0;
	public misses = 0;
	public evictions = 0;
	public readBytes = 0;
	public writtenBytes = 0;

	/** Resolves once the metas are loaded and reconciled with the data backend. Already loaded over sync backends */
	public readonly ready: Promise<void>;
	public loaded = false;
	private readonly dirtyKeys = new Set<string>();
	private settingsDirty = false;
	private saving?: Promise<void>;
	private flushing?: Promise<void>;
	private closed = false;

	public constructor(options: CacheStoreOptions<MB, DB>) {
		this.metaBackend = options.meta;
		this.dataBackend = options.data;
		this.sync = <BothSync<MB, DB>>(options.meta.sync && options.data.sync);
		this.bytesLimit = options.bytesLimit ?? Infinity;
		this.slackBytesOption = options.slackBytes;
		this.saveDelayMs = options.saveDelayMs ?? 10_000;
		this.maxValueBytes = options.maxValueBytes ?? Infinity;
		let loading: MaybePromise<void>;
		try {
			loading = this.load();
		} catch (err) {
			loading = Promise.reject(err);
		}
		// Over sync backends the metas are in once the constructor returns
		if (!(loading instanceof Promise)) this.loaded = true;
		this.ready = Promise.resolve(loading).then(
			() => void (this.loaded = true),
			(err) => {
				// Left empty rather than saving over what the backends hold
				CacheStore.logErr("load", err);
				this.held.clear();
				this.dataBytes = this.metaBytes = 0;
				this.closed = true;
				this.loaded = true;
			},
		);
	}

	/** Bytes eviction goes under the limit, see `CacheStoreOptions.slackBytes` */
	public get slackBytes() {
		return this.slackFor(this.bytesLimit);
	}
	/** Bytes eviction goes under `bytesLimit` (e.g. a cache's user limit, which replaces the store's) */
	public slackFor(bytesLimit: number) {
		return this.slackBytesOption ?? slackOf(bytesLimit);
	}
	/** Bytes of values and metas held */
	public get bytes() {
		return this.dataBytes + this.metaBytes;
	}
	public get size() {
		return this.held.size;
	}
	public has(key: string) {
		return this.held.has(key);
	}
	public meta(key: string): CacheMeta<BackendMetaX<DB>> | undefined {
		return this.held.get(key)?.meta;
	}
	public keys(): Iterable<string> {
		return this.held.keys();
	}
	/** Every key with its meta, for ranking */
	public *metas(): Iterable<[string, CacheMeta<BackendMetaX<DB>>]> {
		for (const [key, held] of this.held) yield [key, held.meta];
	}

	/** The bytes `data` takes here: the data backend's `sizeOf`, or sizeOf.ts. A promise is sized once it resolves */
	public measure(data: BackendValue<DB>): MaybePromise<number> {
		if (<unknown>data instanceof Promise) return (<Promise<BackendValue<DB>>>(<unknown>data)).then((value) => this.measure(value));
		return this.dataBackend.sizeOf !== undefined ? this.dataBackend.sizeOf(data) : sizeOf(data);
	}

	/** The value of `key`, `undefined` if it isn't held. A value the data backend lost drops its meta */
	public get(key: string): StoreOut<this, BackendValue<DB> | undefined> {
		return this.read(key, true);
	}
	/** `get` without counting a hit or miss */
	public peek(key: string): StoreOut<this, BackendValue<DB> | undefined> {
		return this.read(key, false);
	}
	private read(key: string, counted: boolean): StoreOut<this, BackendValue<DB> | undefined> {
		const held = this.held.get(key);
		if (held === undefined) {
			if (counted) this.misses++;
			return this.out(undefined);
		}
		const meta = held.meta;
		const backend = this.dataBackend;
		const value: MaybePromise<BackendValue<DB> | undefined> =
			backend.get !== undefined ? backend.get(key, meta) : thenMaybe(backend.getStream!(key, meta), (stream) => stream && readAll(stream));
		const onValue = (value: BackendValue<DB> | undefined) => {
			if (value === undefined) this.lost(key, meta, counted);
			else if (counted) this.hits++;
			return value;
		};
		// A sync backend's value may itself be a promise (a request in flight), handed back as is rather than waited for
		return this.out(backend.sync ? onValue(<BackendValue<DB> | undefined>value) : thenMaybe(value, onValue));
	}
	/**
	 * The value's bytes `range.start` to `range.end` (inclusive) as a stream, `undefined` if it isn't held. `meta` reads a value being
	 * written (see `Cache.setStream`), whose meta isn't held yet
	 */
	public getStream(
		key: string,
		range: StreamRange = {},
		meta = this.held.get(key)?.meta,
	): StoreOut<this, ReadableStream<Uint8Array> | undefined> {
		if (meta === undefined) {
			this.misses++;
			return this.out(undefined);
		}
		const backend = this.dataBackend;
		const stream: MaybePromise<ReadableStream<Uint8Array> | undefined> =
			backend.getStream !== undefined
				? backend.getStream(key, meta, range)
				: thenMaybe(backend.get!(key, meta), (value) => {
						if (value === undefined) return undefined;
						let bytes: Uint8Array;
						try {
							bytes = toBytes(value);
						} catch {
							throw new Error(`${backend.stats().kind} backend does not stream`);
						}
						return bytesStream(bytes, range.start, range.end === undefined ? undefined : range.end + 1);
					});
		return this.out(
			thenMaybe(stream, (stream) => {
				if (stream !== undefined) this.hits++;
				else if (this.held.get(key)?.meta === meta) this.lost(key, meta);
				else this.misses++;
				return stream;
			}),
		);
	}
	/** A held key whose value is gone (e.g. a file deleted by hand): a miss, and its meta goes */
	private lost(key: string, meta: CacheMeta<BackendMetaX<DB>>, counted = true) {
		if (counted) this.misses++;
		if (this.held.get(key)?.meta === meta) this.drop(key);
	}

	/**
	 * Writes `data` and holds `meta` (its `bytes` set by the caller, see `measure`) once written: readers see the old value until then.
	 * Replaces what `key` held
	 */
	public set(key: string, data: BackendValue<DB>, meta: CacheMeta<BackendMetaX<DB>>): StoreOut<this, void> {
		const backend = this.dataBackend;
		const written: MaybePromise<unknown> =
			backend.set !== undefined ? backend.set(key, data, meta) : backend.setStream!(key, bytesStream(toBytes(data)), meta);
		return this.out(thenMaybe(written, () => this.hold(key, meta)));
	}
	/**
	 * Writes the bytes of `dataStream` and holds `meta` once written, resolves to the bytes. Over `maxValueBytes` (or a failed stream)
	 * it rejects and the backend writes nothing
	 */
	public async setStream(key: string, dataStream: ReadableStream<Uint8Array>, meta: CacheMeta<BackendMetaX<DB>>): Promise<number> {
		const backend = this.dataBackend;
		const capped = this.maxValueBytes === Infinity ? dataStream : dataStream.pipeThrough(this.capStream(key));
		let bytes: number;
		if (backend.setStream !== undefined) bytes = await backend.setStream(key, capped, meta);
		else {
			const all = await readAll(capped);
			await backend.set!(key, <BackendValue<DB>>all, meta);
			bytes = all.byteLength;
		}
		meta.bytes = bytes;
		this.hold(key, meta);
		return bytes;
	}
	/** Passes bytes through until more than `maxValueBytes` went by, then errors */
	private capStream(key: string) {
		let bytes = 0;
		const maxValueBytes = this.maxValueBytes;
		return new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bytes += chunk.byteLength;
				if (bytes > maxValueBytes) controller.error(new Error(`${key} is over the ${maxValueBytes} bytes a value may take here`));
				else controller.enqueue(chunk);
			},
		});
	}
	/** Holds a value the data backend already has (e.g. a file written by someone else), its bytes asked of the backend if `meta.bytes` is unset */
	public adopt(key: string, meta: CacheMeta<BackendMetaX<DB>>): MaybePromise<void> {
		if (meta.bytes > 0 || this.dataBackend.bytesOf === undefined) return this.hold(key, meta);
		return thenMaybe(this.dataBackend.bytesOf(key, meta), (bytes) => {
			if (bytes === undefined) throw new Error(`${key} is not in the ${this.dataBackend.stats().kind} backend`);
			meta.bytes = bytes;
			this.hold(key, meta);
		});
	}
	/** Corrects the bytes of a held value, e.g. once a promise value resolved */
	public resize(key: string, meta: CacheMeta<BackendMetaX<DB>>, bytes: number) {
		if (this.held.get(key)?.meta !== meta) return;
		this.dataBytes += bytes - meta.bytes;
		meta.bytes = bytes;
		this.changed(key);
	}
	/** Notes that `key`'s meta changed (e.g. read again) so the next save writes it */
	public changed(key: string) {
		if (this.closed || !this.held.has(key)) return;
		this.dirtyKeys.add(key);
		this.saveSoon();
	}
	/** Saves `settings` with the next batch */
	public setSettings(settings: CacheSettings) {
		this.settings = settings;
		if (this.closed) return;
		this.settingsDirty = true;
		this.saveSoon();
	}

	/** Stops holding `key` and deletes its value, then (with the next save) its meta. Resolves once the value is deleted */
	public del(key: string): StoreOut<this, void> {
		const held = this.held.get(key);
		if (held === undefined) return this.out(undefined);
		this.drop(key);
		return this.out(this.dataBackend.del(key, held.meta));
	}

	private hold(key: string, meta: CacheMeta<BackendMetaX<DB>>) {
		const replaced = this.held.get(key);
		if (replaced !== undefined) {
			this.dataBytes -= replaced.meta.bytes;
			this.metaBytes -= replaced.metaBytes;
		}
		const metaBytes = this.measureMeta(meta);
		this.held.set(key, { meta, metaBytes });
		this.dataBytes += meta.bytes;
		this.metaBytes += metaBytes;
		this.writtenBytes += meta.bytes;
		this.changed(key);
	}
	private drop(key: string) {
		const held = this.held.get(key);
		if (held === undefined) return;
		this.held.delete(key);
		this.dataBytes -= held.meta.bytes;
		this.metaBytes -= held.metaBytes;
		if (this.closed) return;
		this.dirtyKeys.add(key);
		this.saveSoon();
	}
	private measureMeta(meta: CacheMeta<BackendMetaX<DB>>): number {
		const size = this.metaBackend.sizeOf !== undefined ? this.metaBackend.sizeOf(meta) : sizeOf(meta);
		return typeof size === "number" ? size : 0;
	}
	/** `value` as this store gives it: as is from a sync store, as a promise otherwise */
	private out<T>(value: MaybePromise<T>): StoreOut<this, T> {
		return <StoreOut<this, T>>(this.sync || value instanceof Promise ? value : Promise.resolve(value));
	}

	/** Loads the metas and settings, then reconciles them with the data backend */
	private load(): MaybePromise<void> {
		const meta = this.metaBackend;
		const stored: MaybePromise<Iterable<[string, unknown]>> =
			meta.entries !== undefined
				? meta.entries()
				: thenMaybe(meta.keys(), (keys) => {
						const pairs: MaybePromise<[string, unknown]>[] = [];
						let async = false;
						for (const key of keys) {
							const value = meta.get(key);
							if (value instanceof Promise) async = true;
							pairs.push(thenMaybe(value, (value): [string, unknown] => [key, value]));
						}
						return async ? Promise.all(pairs) : <[string, unknown][]>pairs;
					});
		return thenMaybe(stored, (stored) => {
			const metas = new Map<string, CacheMeta<BackendMetaX<DB>>>();
			for (const [key, value] of stored) {
				if (value === undefined || value === null) continue;
				if (key === CacheStore.settingsKey) this.settings = <CacheSettings>value;
				else metas.set(key, <CacheMeta<BackendMetaX<DB>>>value);
			}
			return thenMaybe(this.reconcile(metas), ({ missing, orphans }) => {
				for (const key of missing) {
					metas.delete(key);
					this.dirtyKeys.add(key);
				}
				for (const [key, meta] of metas) {
					const metaBytes = this.measureMeta(meta);
					this.held.set(key, { meta, metaBytes });
					this.dataBytes += meta.bytes;
					this.metaBytes += metaBytes;
				}
				this.orphans = orphans;
				if (this.dirtyKeys.size !== 0) this.saveSoon();
			});
		});
	}
	/**
	 * The data backend's `reconcile`, or without one: metas whose key the data backend lacks are missing, and its keys without a meta are
	 * deleted (e.g. written just before a crash, ahead of their meta's save)
	 */
	private reconcile(metas: ReadonlyMap<string, CacheMeta<BackendMetaX<DB>>>): MaybePromise<ReconcileResult> {
		const data = this.dataBackend;
		if (data.reconcile !== undefined) return data.reconcile(metas);
		if (data.keys === undefined) return { missing: [], orphans: [] };
		return thenMaybe(data.keys(), (keys) => {
			const dataKeys = new Set(keys);
			const missing: string[] = [];
			for (const key of metas.keys()) if (!dataKeys.has(key)) missing.push(key);
			const deleting: Promise<unknown>[] = [];
			for (const key of dataKeys) {
				if (metas.has(key)) continue;
				const deleted = data.del(key);
				if (deleted instanceof Promise) deleting.push(deleted.catch(CacheStore.logErr.withContext("delete orphan", key)));
			}
			const result = { missing, orphans: [] };
			return deleting.length === 0 ? result : Promise.all(deleting).then(() => result);
		});
	}

	private saveSoon() {
		this.saving ??= sleep(this.saveDelayMs).then(() => {
			this.saving = undefined;
			return this.flush();
		});
	}
	/** Saves the changed metas and settings now, after a save already running so they land in order */
	public async flush(): Promise<void> {
		while (this.flushing !== undefined) await this.flushing;
		if (this.dirtyKeys.size === 0 && !this.settingsDirty) return;
		this.flushing = this.save().finally(() => (this.flushing = undefined));
		await this.flushing;
	}
	/** Writes the changed metas and settings. A failed write is logged and tried again with the next save */
	private async save() {
		const meta = this.metaBackend;
		// Every write starts before the first await: a backend that writes synchronously (SqliteBackend) has written them all when this
		// returns, the main process exits without waiting for promises
		const writes: MaybePromise<unknown>[] = [];
		const retry = (onFail: () => void) => (err: unknown) => {
			onFail();
			throw err;
		};
		if (this.settingsDirty) {
			this.settingsDirty = false;
			writes.push(
				this.tryWrite(
					() => meta.set(CacheStore.settingsKey, this.settings),
					retry(() => (this.settingsDirty = true)),
				),
			);
		}
		for (const key of this.dirtyKeys) {
			const held = this.held.get(key);
			writes.push(
				this.tryWrite(
					() => (held === undefined ? meta.del(key) : meta.set(key, held.meta)),
					retry(() => this.dirtyKeys.add(key)),
				),
			);
		}
		this.dirtyKeys.clear();
		for (const result of await Promise.allSettled(writes)) {
			if (result.status === "rejected") return CacheStore.logErr("save", result.reason);
		}
	}
	/** Runs `write`, a meta backend write, passing a sync throw or async rejection to `onFail` */
	private tryWrite(write: () => MaybePromise<unknown>, onFail: (err: unknown) => never): MaybePromise<unknown> {
		try {
			const written = write();
			return written instanceof Promise ? written.catch(onFail) : written;
		} catch (err) {
			return Promise.reject(err).catch(onFail);
		}
	}
	/** Saves what changed and stops saving, e.g. when the process exits */
	public close() {
		const flushed = this.flush();
		this.closed = true;
		return flushed;
	}

	public stats(): StoreStats {
		return {
			entries: this.held.size,
			metaBytes: this.metaBytes,
			dataBytes: this.dataBytes,
			bytesLimit: this.bytesLimit,
			hits: this.hits,
			misses: this.misses,
			evictions: this.evictions,
			readBytes: this.readBytes,
			writtenBytes: this.writtenBytes,
			meta: this.metaBackend.stats(),
			data: this.dataBackend.stats(),
		};
	}
}
