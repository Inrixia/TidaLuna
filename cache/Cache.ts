// A size-bounded cache over a memory store and an optional persist store (see CacheStore.ts). The cache holds the policy: LRFU eviction
// in each store against its own limit (Cache.lrfu.ts), promotion of values read from persist into memory, write modes, max ages and
// stale-while-revalidate. Tiering is invisible to callers: every store holds the same values and metas, memory only the recent ones.
// Caches are made once per key by `Cache.from` and live for the runtime; wrappers add behaviour through `attach`, see Cache.hooks.ts
import { asyncDebounce, registerEmitter, sleep, type AddReceiver, type Emit, type MaybePromise } from "@inrixia/helpers";

import { createLogger } from "../render/src/trace/createLogger";
import type { CacheHooks } from "./Cache.hooks";
import { expired, rank, touch } from "./Cache.lrfu";
import type { CacheControl, CacheMeta, CacheOptions, CacheSetOptions, CacheStats, CacheWriteMode } from "./Cache.types";
import type { AnyCacheStore, BackendMetaX, BackendValue, CacheStore, StoreOut } from "./CacheStore";
import type { CacheStoreBackendBase, MetaBackend, StreamRange } from "./CacheStoreBackend";

/** The values a store holds */
export type StoreValue<S> = S extends CacheStore<any, infer DB> ? BackendValue<DB> : never;
/** What a store's data backend needs in a meta besides `CacheMeta` */
export type StoreMetaX<S> = S extends CacheStore<any, infer DB> ? BackendMetaX<DB> : unknown;
/** A store of binary values, which can be streamed */
export type BinaryCacheStore = CacheStore<MetaBackend, CacheStoreBackendBase<Uint8Array, any, any>>;
/** The unload set `attach` and `onStats` take, a plugin's `unloads` */
type Unloads = Parameters<AddReceiver<unknown>>[0];

const statsDelayMs = 500;

export class Cache<
	MemS extends AnyCacheStore = AnyCacheStore,
	PersistS extends AnyCacheStore | undefined = AnyCacheStore | undefined,
> implements CacheControl {
	private static readonly logErr = createLogger("[Cache]", console.error);
	/** Every cache in this runtime by key, see `from` */
	public static readonly caches = new Map<string, Cache<any, any>>();
	/** What the UI works every cache through by key: the caches of this runtime, and (in the page) proxies of the main process's keyed `native:<key>` */
	public static readonly controls = new Map<string, CacheControl>();
	private static readonly controlAdded = registerEmitter<CacheControl>();
	/** Calls back with every control added to `controls` */
	public static readonly onControlAdded = Cache.controlAdded[0];
	private static readonly anyStats = registerEmitter<CacheStats>();
	/** Calls back with the stats of any cache whenever they change, e.g. to send them from the main process to the page */
	public static readonly onAnyStats = Cache.anyStats[0];

	/**
	 * The cache of `key`, made from `options` the first time. The factory builds every store and backend (`new CacheStore({ meta, data })`),
	 * and runs once per key: later calls (e.g. a plugin reloaded) get the same cache, so behaviour that closes over a caller goes in `attach`
	 */
	public static from<MemS extends AnyCacheStore, PersistS extends AnyCacheStore | undefined = undefined>(
		key: string,
		options: () => CacheOptions<MemS, PersistS>,
	): Cache<MemS, PersistS> {
		const existing = Cache.caches.get(key);
		if (existing !== undefined) return existing;
		const cache = new Cache<MemS, PersistS>(key, options());
		Cache.caches.set(key, cache);
		Cache.addControl(cache);
		return cache;
	}
	/** Adds a control to `controls`, e.g. a proxy of a main process cache */
	public static addControl(control: CacheControl) {
		Cache.controls.set(control.key, control);
		Cache.controlAdded[1](control, Cache.logErr.withContext("onControlAdded", control.key));
	}
	/** Saves every cache's changed metas now, e.g. when the process exits. Meta backends that write synchronously have when it returns */
	public static flushAll() {
		for (const cache of Cache.caches.values()) void cache.flush();
	}

	public readonly memoryStore: MemS;
	public readonly persistStore: PersistS;
	public readonly desc?: string;
	public write: CacheWriteMode;
	public halfLifeMs: number;
	public maxAgeMs: number;
	public revalidateAfterMs?: number;
	/** What the user set, `undefined` for the store's default. Kept in the persist store's settings */
	public userBytesLimit?: number;
	/** Background revalidations run */
	public revalidations = 0;
	/** Resolves once the persist store is loaded, expired entries dropped and what is over the limit evicted */
	public readonly ready: Promise<void>;

	private hooks: CacheHooks<StoreValue<MemS>, CacheX<MemS, PersistS>> = {};
	private attached = false;
	/** Data backend operations queued per key, see `queue` */
	private readonly pending = new Map<string, Promise<unknown>>();
	/** Values being streamed in by `setStream`, with the meta their memory store reads them by until then */
	private readonly filling = new Map<string, { meta: CacheMeta<any>; done: Promise<void> }>();
	private readonly revalidating = new Set<string>();
	private statsQueued = false;

	/** Calls back with a key whose value was replaced by a revalidation, e.g. to re-render what shows it */
	public readonly onChange: AddReceiver<string>;
	private readonly emitChange: Emit<string>;
	public readonly onStats: AddReceiver<CacheStats>;
	private readonly emitStats: Emit<CacheStats>;

	private constructor(
		public readonly key: string,
		options: CacheOptions<MemS, PersistS>,
	) {
		this.memoryStore = options.memory;
		this.persistStore = <PersistS>options.persist;
		this.desc = options.desc;
		this.write = options.write ?? "sync";
		this.halfLifeMs = options.halfLifeMs ?? 7 * 24 * 60 * 60_000;
		this.maxAgeMs = options.maxAgeMs ?? Infinity;
		this.revalidateAfterMs = options.revalidateAfterMs;
		[this.onChange, this.emitChange] = registerEmitter<string>();
		[this.onStats, this.emitStats] = registerEmitter<CacheStats>();
		this.ready = (this.persistStore?.ready ?? Promise.resolve()).then(() => this.loaded());
	}
	/** Once the persist store loaded: its settings apply, expired entries go, then what is over the limit */
	private async loaded() {
		const persist = this.persistStore;
		this.userBytesLimit = persist?.settings.userBytesLimit;
		const removing: Promise<void>[] = [];
		for (const [key, meta] of (persist ?? this.memoryStore).metas()) if (expired(meta)) removing.push(this.remove(key));
		await Promise.all(removing);
		await this.evict();
	}

	/** Adds `hooks` until `unloads` runs. One set at a time: a second `attach` throws until the first is unloaded */
	public attach(hooks: CacheHooks<StoreValue<MemS>, CacheX<MemS, PersistS>>, unloads: Unloads) {
		if (this.attached) throw new Error(`Cache ${this.key} already has hooks attached`);
		this.hooks = hooks;
		this.attached = true;
		unloads.add(() => {
			if (this.hooks !== hooks) return;
			this.hooks = {};
			this.attached = false;
		});
		this.statsChanged();
	}

	/** The store eviction limits by the user's limit: persist when there is one */
	private get topStore(): AnyCacheStore {
		return this.persistStore ?? this.memoryStore;
	}
	/** The cap from `CacheHooks.maxBytesLimit` */
	public get maxBytesLimit() {
		return this.hooks.maxBytesLimit?.() ?? Infinity;
	}
	/** Bytes the cache may hold: the user's limit or the top store's, capped by `maxBytesLimit` */
	public get bytesLimit() {
		return Math.min(this.userBytesLimit ?? this.topStore.bytesLimit, this.maxBytesLimit);
	}
	public get size() {
		return this.topStore.size;
	}
	public keys(): Iterable<string> {
		return this.topStore.keys();
	}
	/** The meta of `key`, from persist when there is one */
	public meta(key: string): CacheMeta<CacheX<MemS, PersistS>> | undefined {
		return this.persistStore?.meta(key) ?? this.memoryStore.meta(key);
	}
	/** Whether `key` is being streamed in (`filling`) or held whole in any store (`complete`) */
	public status(key: string): "filling" | "complete" | undefined {
		if (this.filling.has(key)) return "filling";
		const meta = this.meta(key);
		if (meta === undefined) return undefined;
		if (!expired(meta)) return "complete";
		void this.remove(key);
	}
	/** Whether `key` is held whole, in memory or persisted */
	public has(key: string) {
		return this.status(key) === "complete";
	}
	/** Counts a read of `key` without reading its value, e.g. a value fetched again that came back unchanged. `false` if it isn't held */
	public touch(key: string): boolean {
		if (!this.has(key)) return false;
		this.hit(key, this.memoryStore, 0);
		return true;
	}

	/** The value of `key` in memory without counting a read. Synchronous over a sync memory store */
	public peek(key: string): StoreOut<MemS, StoreValue<MemS> | undefined> {
		return this.memoryStore.peek(key);
	}
	/**
	 * The value of `key` in memory, counting a read (of `readBytes`, for the stats) and revalidating it if stale. Synchronous over a sync memory
	 * store. Doesn't read the persist store, see `read`
	 */
	public get(key: string, readBytes = 0): StoreOut<MemS, StoreValue<MemS> | undefined> {
		const memory = this.memoryStore;
		const meta = memory.meta(key);
		if (meta !== undefined && expired(meta)) void this.remove(key);
		const onValue = (value: StoreValue<MemS> | undefined) => {
			if (value !== undefined) this.hit(key, memory, readBytes, value);
			else this.statsChanged();
			return value;
		};
		const value = memory.get(key);
		// A sync store's value may itself be a promise (a request in flight), returned as is
		return <StoreOut<MemS, StoreValue<MemS> | undefined>>(
			(memory.sync ? onValue(<StoreValue<MemS> | undefined>value) : (<Promise<StoreValue<MemS> | undefined>>value).then(onValue))
		);
	}
	/** The value of `key` from memory, otherwise from the persist store, then held in memory too. Reads of a key in flight share one */
	public async read(key: string, readBytes = 0): Promise<StoreValue<MemS> | undefined> {
		const inMemory = await this.get(key, readBytes);
		if (inMemory !== undefined || this.persistStore === undefined) return inMemory;
		const value = await this.readPersisted(key);
		if (value !== undefined) this.hit(key, this.persistStore, readBytes, value);
		return value;
	}
	/** Reads `key` from the persist store and promotes it into memory. A failed read is logged and missed */
	private readonly readPersisted = asyncDebounce(async (key: string): Promise<StoreValue<MemS> | undefined> => {
		const persist = this.persistStore!;
		if (!persist.loaded) await this.ready;
		const meta = persist.meta(key);
		if (meta === undefined || expired(meta)) {
			if (meta !== undefined) void this.remove(key);
			persist.misses++;
			return void this.statsChanged();
		}
		try {
			const value = <StoreValue<MemS> | undefined>await this.queue(key, () => persist.get(key));
			if (value === undefined) return void this.statsChanged();
			// Promoted: memory holds what was read recently
			await this.holdIn(this.memoryStore, key, value, { ...meta });
			await this.evict(key);
			return value;
		} catch (err) {
			// Never rejects: asyncDebounce leaves a rejection of its shared promise unhandled
			Cache.logErr.withContext(this.key, "read", key)(err);
			return void this.statsChanged();
		}
	});
	/** Counts a read of `key` from `store`: its score in every store, the stats, and a revalidation if `value` is given and stale */
	private hit(key: string, store: AnyCacheStore, readBytes: number, value?: StoreValue<MemS>) {
		store.readBytes += readBytes;
		const now = Date.now();
		const persistMeta = this.persistStore?.meta(key);
		const memoryMeta = this.memoryStore.meta(key);
		// Persist holds the score when there is one, memory copies it
		const meta = persistMeta ?? memoryMeta;
		if (meta === undefined) return;
		touch(meta, this.halfLifeMs, now);
		if (memoryMeta !== undefined && memoryMeta !== meta) {
			memoryMeta.crf = meta.crf;
			memoryMeta.last = meta.last;
		}
		if (persistMeta !== undefined) this.persistStore!.changed(key);
		this.memoryStore.changed(key);
		this.statsChanged();
		if (value !== undefined) this.revalidateIfStale(key, value, meta);
	}

	/**
	 * Stores `value` in every store, sized by the `sizeOf` hook or each data backend, and written to the persist store as `write` says.
	 * A new key counts as read once, replacing a value keeps its score. Held in memory before this returns unless `write` is `atomic`
	 */
	public async set(key: string, value: StoreValue<MemS>, options: CacheSetOptions<CacheX<MemS, PersistS>> = {}): Promise<void> {
		const write = options.write ?? this.write;
		const meta = this.newMeta(key, options);
		const persist = this.persistStore;
		if (write === "atomic" && persist !== undefined) {
			if (!persist.loaded) await this.ready;
			await this.queue(key, () => this.holdIn(persist, key, value, { ...meta }));
			await persist.flush();
			await this.holdIn(this.memoryStore, key, value, meta);
			this.statsChanged();
			return this.evict(key);
		}
		const inMemory = this.holdIn(this.memoryStore, key, value, meta);
		if (persist !== undefined) {
			const persisting = (persist.loaded ? Promise.resolve() : this.ready).then(() =>
				this.queue(key, () => this.holdIn(persist, key, value, { ...meta })),
			);
			if (write === "async") persisting.catch(Cache.logErr.withContext(this.key, "write", key));
			else await persisting;
		}
		await inMemory;
		this.statsChanged();
		await this.evict(key);
	}
	/**
	 * Stores the bytes of `dataStream` in every store as they arrive: readers of `getStream` get them meanwhile (`status` is `filling`).
	 * A store that can't take a value of this size leaves it out. A failed stream, or a failed persist write, leaves nothing behind in any store
	 */
	public async setStream(
		this: Cache<BinaryCacheStore, BinaryCacheStore | undefined>,
		key: string,
		dataStream: ReadableStream<Uint8Array>,
		options: CacheSetOptions<CacheX<MemS, PersistS>> = {},
	): Promise<void> {
		const memory = this.memoryStore;
		const persist = this.persistStore;
		const meta = this.newMeta(key, options);
		let toMemory = dataStream;
		let toPersist: ReadableStream<Uint8Array> | undefined;
		if (persist !== undefined) [toMemory, toPersist] = dataStream.tee();
		const inMemory = memory.setStream(key, toMemory, meta);
		const done = (async () => {
			if (persist === undefined) return void (await inMemory);
			// A memory store failing alone (e.g. over its `maxValueBytes`) only leaves the value out of memory
			const heldInMemory = inMemory.then(
				() => true,
				() => false,
			);
			if (!persist.loaded) await this.ready;
			await this.queue(key, () => persist.setStream(key, toPersist!, { ...meta }));
			if (!(await heldInMemory)) await memory.del(key);
		})();
		this.filling.set(key, { meta, done });
		this.statsChanged();
		try {
			await done;
		} catch (err) {
			// The memory store may still be reading the stream: dropped once it is done, unless replaced meanwhile
			const dropMemory = () => {
				if (memory.meta(key) === meta) Promise.resolve(memory.del(key)).catch(Cache.logErr.withContext(this.key, "delete", key));
			};
			inMemory.then(dropMemory, dropMemory);
			throw err;
		} finally {
			this.filling.delete(key);
			this.statsChanged();
		}
		if ((options.write ?? this.write) === "atomic") await persist?.flush();
		await this.evict(key);
	}
	/**
	 * Bytes `range.start` to `range.end` (inclusive) of `key`'s value as a stream: from memory, while it is being streamed in too, otherwise
	 * from the persist store. Each call is its own reader, holding the entry from eviction until it ends
	 */
	public async getStream(
		this: Cache<BinaryCacheStore, BinaryCacheStore | undefined>,
		key: string,
		range: StreamRange = {},
	): Promise<ReadableStream<Uint8Array> | undefined> {
		const memory = this.memoryStore;
		const filling = this.filling.get(key);
		// shortcut: a reader of a value being streamed in errors if memory then drops it (over its `maxValueBytes`), wait for `status` complete if that matters
		if (filling !== undefined) {
			const stream = await memory.getStream(key, range, filling.meta);
			if (stream !== undefined) return stream;
			// Not held in memory (too large for it): read from persist once there
			await filling.done.catch(() => {});
		}
		const memoryMeta = memory.meta(key);
		if (memoryMeta !== undefined && !expired(memoryMeta)) {
			const stream = await memory.getStream(key, range);
			if (stream !== undefined) {
				this.hit(key, memory, 0);
				return stream;
			}
		}
		const persist = this.persistStore;
		if (persist === undefined) return;
		if (!persist.loaded) await this.ready;
		const meta = persist.meta(key);
		if (meta === undefined || expired(meta)) {
			if (meta !== undefined) void this.remove(key);
			persist.misses++;
			return;
		}
		// shortcut: streams from persist aren't promoted into memory (a large value would push out everything else), promote by `read` if needed
		const stream = await this.queue(key, () => persist.getStream(key, range));
		if (stream !== undefined) this.hit(key, persist, 0);
		return stream;
	}
	/** Holds a value the persist store's data backend already has (e.g. a file written into its folder by someone else) */
	public async adopt(key: string, meta: CacheX<MemS, PersistS> & Partial<CacheMeta>): Promise<void> {
		const store = this.topStore;
		if (!store.loaded) await this.ready;
		const now = Date.now();
		await store.adopt(key, { crf: 1, last: now, written: now, ...meta, bytes: meta.bytes ?? 0 });
		this.statsChanged();
		await this.evict(key);
	}

	/** Deletes `key` from every store, only if its value in memory is still `value` if given (e.g. dropping a failed request that may have been replaced) */
	public async delete(key: string, value?: StoreValue<MemS>): Promise<boolean> {
		if (value !== undefined) {
			const memory = this.memoryStore;
			// Not awaited over a sync store: its value may be a promise (a request in flight), compared as is
			const held = memory.sync ? memory.peek(key) : await memory.peek(key);
			if (held !== value) return false;
		}
		if (this.status(key) === undefined) return false;
		await this.remove(key);
		return true;
	}
	/** Deletes every entry that isn't pinned */
	public async clear(): Promise<void> {
		await this.ready;
		const keys = new Set<string>();
		for (const store of [this.memoryStore, this.persistStore]) {
			if (store === undefined) continue;
			for (const key of store.keys()) if (!this.isPinned(store, key)) keys.add(key);
		}
		await Promise.all([...keys].map((key) => this.remove(key)));
	}
	/** Bytes the cache may hold, `undefined` for the default. Kept in the persist store, evicts what no longer fits */
	public async setUserBytesLimit(bytes?: number): Promise<void> {
		await this.ready;
		this.userBytesLimit = bytes;
		this.persistStore?.setSettings({ ...this.persistStore.settings, userBytesLimit: bytes });
		this.statsChanged();
		await this.evict();
	}

	/** Holds `value` in `store` sized by the `sizeOf` hook or the store, not if it is over the store's `maxValueBytes`. A size that rejects drops the entry */
	private holdIn(store: AnyCacheStore, key: string, value: StoreValue<MemS>, meta: CacheMeta<any>): MaybePromise<void> {
		const size = this.hooks.sizeOf?.(value) ?? store.measure(value);
		if (typeof size === "number") {
			if (size > store.maxValueBytes) return store.del(key);
			meta.bytes = size;
			return store.set(key, value, meta);
		}
		meta.bytes = 0;
		size.then(
			(bytes) => {
				if (store.meta(key) !== meta) return;
				if (bytes > store.maxValueBytes) return void store.del(key);
				store.resize(key, meta, bytes);
				this.evict().catch(Cache.logErr.withContext(this.key, "evict"));
			},
			() => void this.delete(key, value),
		);
		return store.set(key, value, meta);
	}
	private newMeta(key: string, options: CacheSetOptions<CacheX<MemS, PersistS>>): CacheMeta<any> {
		const replaced = this.meta(key);
		const now = Date.now();
		const maxAgeMs = options.maxAgeMs ?? this.maxAgeMs;
		const revalidateAfterMs = options.revalidateAfterMs ?? this.revalidateAfterMs;
		return {
			...options.meta,
			bytes: 0,
			crf: replaced?.crf ?? 1,
			last: replaced?.last ?? now,
			written: now,
			// Left out rather than Infinity, which JSON saves as null
			maxAgeMs: Number.isFinite(maxAgeMs) ? maxAgeMs : undefined,
			revalidateAfterMs: revalidateAfterMs !== undefined && Number.isFinite(revalidateAfterMs) ? revalidateAfterMs : undefined,
		};
	}

	/** Revalidates `key` in the background if it was written over its `revalidateAfterMs` ago, see `CacheHooks.revalidate` */
	private revalidateIfStale(key: string, value: StoreValue<MemS>, meta: CacheMeta<any>) {
		const revalidate = this.hooks.revalidate;
		if (revalidate === undefined || meta.revalidateAfterMs === undefined || Date.now() - meta.written < meta.revalidateAfterMs) return;
		if (this.revalidating.has(key)) return;
		this.revalidating.add(key);
		this.revalidations++;
		revalidate(key, value, meta)
			.then(
				async (next) => {
					// Replaced or removed meanwhile, or kept as is to try again on the next read
					if (this.meta(key) !== meta || next === value) return;
					if (next === undefined) {
						const now = Date.now();
						meta.written = now;
						const memoryMeta = this.memoryStore.meta(key);
						if (memoryMeta !== undefined) memoryMeta.written = now;
						this.persistStore?.changed(key);
						return this.memoryStore.changed(key);
					}
					await this.set(key, next, { meta: meta, maxAgeMs: meta.maxAgeMs ?? Infinity, revalidateAfterMs: meta.revalidateAfterMs });
					this.emitChange(key, Cache.logErr.withContext(this.key, "onChange", key));
				},
				() => {
					if (this.meta(key) === meta) void this.remove(key);
				},
			)
			.catch(Cache.logErr.withContext(this.key, "revalidate", key))
			.finally(() => {
				this.revalidating.delete(key);
				this.statsChanged();
			});
	}

	/**
	 * Runs `op`, a persist store read, write or delete of `key`, once the ones queued for `key` before it settled, so they land in the order they
	 * were made: a delete queued after a write can't run first and leave the value behind. Resolves or rejects with `op`
	 */
	private queue<T>(key: string, op: () => MaybePromise<T>): Promise<T> {
		const run = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(op);
		this.pending.set(key, run);
		const done = () => this.pending.get(key) === run && this.pending.delete(key);
		run.then(done, done);
		return run;
	}
	/** Deletes `key` from every store, resolves once its value is deleted. A failed delete is logged */
	private async remove(key: string): Promise<void> {
		const deleting: MaybePromise<void>[] = [this.memoryStore.del(key)];
		const persist = this.persistStore;
		if (persist !== undefined) deleting.push(this.queue(key, () => persist.del(key)));
		this.statsChanged();
		for (const result of await Promise.allSettled(deleting)) {
			if (result.status === "rejected") Cache.logErr.withContext(this.key, "delete", key)(result.reason);
		}
	}

	private isPinned(store: AnyCacheStore, key: string) {
		return this.hooks.isPinned?.(key) === true || store.dataBackend.pinned?.(key) === true;
	}
	/** The keys over `bytesLimit` evicts from `store`, lowest ranked first, until under it by the slack. `keep` (the entry just written) and pinned ones stay */
	private victims(store: AnyCacheStore, bytesLimit: number, keep?: string): string[] {
		let bytes = store.bytes;
		if (bytes <= bytesLimit) return [];
		const target = bytesLimit - store.slackFor(bytesLimit);
		const ranked = [...store.metas()].sort((a, b) => rank(a[1], this.halfLifeMs) - rank(b[1], this.halfLifeMs));
		const victims: string[] = [];
		for (const [key, meta] of ranked) {
			if (bytes <= target) break;
			if (key === keep || this.isPinned(store, key)) continue;
			victims.push(key);
			bytes -= meta.bytes;
		}
		return victims;
	}
	/**
	 * Evicts the lowest ranked entries until each store is within its limit: the top store (persist, or memory alone) by `bytesLimit`, deleting
	 * from every store; memory under a persist store by its own, keeping them persisted. `keep` (the entry just written) stays
	 */
	public async evict(keep?: string): Promise<void> {
		const memory = this.memoryStore;
		const persist = this.persistStore;
		const top = persist ?? memory;
		const removing: Promise<void>[] = [];
		for (const key of this.victims(top, this.bytesLimit, keep)) {
			top.evictions++;
			removing.push(this.remove(key));
		}
		if (persist !== undefined) {
			for (const key of this.victims(memory, memory.bytesLimit, keep)) {
				memory.evictions++;
				removing.push(Promise.resolve(memory.del(key)));
			}
		}
		if (removing.length === 0) return;
		this.statsChanged();
		await Promise.all(removing);
	}

	public stats(): CacheStats {
		return {
			key: this.key,
			desc: this.desc,
			entries: this.size,
			bytes: this.topStore.bytes,
			userBytesLimit: this.userBytesLimit,
			bytesLimit: this.bytesLimit,
			maxBytesLimit: this.maxBytesLimit,
			revalidations: this.revalidations,
			memory: this.memoryStore.stats(),
			persist: this.persistStore?.stats(),
			extra: this.hooks.stats?.(),
		};
	}
	/** Emits the stats to `onStats` and `Cache.onAnyStats` listeners, at most once per `statsDelayMs` */
	public statsChanged() {
		if (this.statsQueued) return;
		this.statsQueued = true;
		void sleep(statsDelayMs).then(() => {
			this.statsQueued = false;
			const stats = this.stats();
			this.emitStats(stats, Cache.logErr.withContext(this.key, "onStats"));
			Cache.anyStats[1](stats, Cache.logErr.withContext(this.key, "onAnyStats"));
		});
	}
	/** Saves both stores' changed metas now */
	public async flush(): Promise<void> {
		await Promise.all([this.memoryStore.flush(), this.persistStore?.flush()]);
	}
}

/** What a cache's data backends need in a meta besides `CacheMeta`, in every store */
export type CacheX<MemS, PersistS> = StoreMetaX<MemS> & (PersistS extends AnyCacheStore ? StoreMetaX<PersistS> : unknown);
