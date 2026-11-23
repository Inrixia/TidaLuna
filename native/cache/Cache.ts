// Generic cache index with size/entry limits, eviction and stats. Holds values in memory, or only describes them (a DiskCache keeps the bytes in files).
// Eviction is LRFU (least recently / least frequently used): every read adds one to an entry's score, which halves every `halfLifeMs`,
// so a track played 20 times last month still outranks one played once yesterday, but not forever. Writes are not reads, except that a new entry
// counts as read once (it was just wanted), so rewriting a value doesn't make it look popular.

export type CacheOptions<V> = {
	/** Bytes the cache may hold, `Infinity` for no limit. A function is read on every eviction (e.g. limited by free disk space) */
	maxBytes?: number | (() => number);
	/** Entries the cache may hold, past this it drops 5% below so evicting doesn't run for every write */
	maxEntries?: number;
	/** Time for an entry's score to halve, 7 days by default */
	halfLifeMs?: number;
	/** An entry that can't be evicted right now, e.g. it is being read */
	isPinned?: (key: string, value: V) => boolean;
	/** Called after an entry was evicted for space (not when deleted) */
	onEvict?: (key: string, value: V, bytes: number) => void;
};

export type CacheStats = {
	entries: number;
	/** Bytes held */
	usage: number;
	/** Bytes the cache may hold */
	limit: number;
	hits: number;
	misses: number;
	/** Bytes of reads, as given by the reader */
	readBytes: number;
	/** Bytes of new and replaced values */
	writtenBytes: number;
	evictions: number;
	evictedBytes: number;
};

/** What eviction ranks an entry by, so it can be kept across restarts */
export type CacheAccess = { last: number; crf: number };

type Slot<V> = { value: V; bytes: number; last: number; crf: number };

const day = 24 * 60 * 60_000;

export class Cache<V = unknown> {
	protected readonly slots = new Map<string, Slot<V>>();
	private readonly halfLifeMs: number;
	private bytes = 0;
	private readonly counters = { hits: 0, misses: 0, readBytes: 0, writtenBytes: 0, evictions: 0, evictedBytes: 0 };
	private readonly listeners = new Set<() => void>();

	public maxBytes: number | (() => number);
	public maxEntries: number;

	public constructor(private readonly options: CacheOptions<V> = {}) {
		this.halfLifeMs = options.halfLifeMs ?? 7 * day;
		this.maxBytes = options.maxBytes ?? Infinity;
		this.maxEntries = options.maxEntries ?? Infinity;
	}

	public get size() {
		return this.slots.size;
	}
	public get usage() {
		return this.bytes;
	}
	public get limit() {
		return typeof this.maxBytes === "function" ? this.maxBytes() : this.maxBytes;
	}

	/** Eviction rank: the log2 of the score at time 0, so it never needs decaying to compare. Lowest goes first */
	private rank({ last, crf }: Slot<V> | CacheAccess) {
		return last / this.halfLifeMs + Math.log2(crf);
	}
	private read(slot: Slot<V>, now = Date.now()) {
		slot.crf = slot.crf * 2 ** (-(now - slot.last) / this.halfLifeMs) + 1;
		slot.last = now;
	}

	/** The value, counts as a read. `readBytes` is how much of it the reader used */
	public get(key: string, readBytes = 0): V | undefined {
		const slot = this.slots.get(key);
		if (slot === undefined) {
			this.counters.misses++;
			this.changed();
			return;
		}
		this.hit(slot, readBytes);
		return slot.value;
	}
	/** Counts a read of `key` without returning it, `false` if it isn't held */
	public touch(key: string, readBytes = 0): boolean {
		const slot = this.slots.get(key);
		if (slot === undefined) return false;
		this.hit(slot, readBytes);
		return true;
	}
	private hit(slot: Slot<V>, readBytes: number) {
		this.read(slot);
		this.counters.hits++;
		this.counters.readBytes += readBytes;
		this.changed();
	}
	/** The value without counting a read */
	public peek(key: string): V | undefined {
		return this.slots.get(key)?.value;
	}
	public has(key: string) {
		return this.slots.has(key);
	}
	public bytesOf(key: string) {
		return this.slots.get(key)?.bytes;
	}
	public keys() {
		return this.slots.keys();
	}
	public *entries(): IterableIterator<[string, V]> {
		for (const [key, slot] of this.slots) yield [key, slot.value];
	}

	/** Stores `value`. A new key counts as read once, replacing a value keeps its score */
	public set(key: string, value: V, bytes = 0, access?: CacheAccess): this {
		const slot = this.slots.get(key);
		if (slot !== undefined) {
			this.bytes += bytes - slot.bytes;
			slot.value = value;
			slot.bytes = bytes;
		} else {
			this.slots.set(key, { value, bytes, last: access?.last ?? Date.now(), crf: access?.crf ?? 1 });
			this.bytes += bytes;
		}
		this.counters.writtenBytes += bytes;
		this.evict(key);
		this.changed();
		return this;
	}
	public delete(key: string): boolean {
		const slot = this.slots.get(key);
		if (slot === undefined) return false;
		this.slots.delete(key);
		this.bytes -= slot.bytes;
		this.changed();
		return true;
	}
	public clear() {
		this.slots.clear();
		this.bytes = 0;
		this.changed();
	}

	/** The score state of `key` for keeping it across restarts, see `set` */
	public accessOf(key: string): CacheAccess | undefined {
		const slot = this.slots.get(key);
		return slot && { last: slot.last, crf: slot.crf };
	}
	/** Entries in the order eviction takes them, with their bytes and last read time */
	public *ranked(): IterableIterator<{ key: string; bytes: number; last: number; crf: number }> {
		const sorted = [...this.slots].sort(([, a], [, b]) => this.rank(a) - this.rank(b));
		for (const [key, { bytes, last, crf }] of sorted) yield { key, bytes, last, crf };
	}

	/** Evicts lowest ranked entries until within the limits. `keep` (the entry just written) goes last */
	public evict(keep?: string) {
		const maxBytes = this.limit;
		const overBytes = this.bytes > maxBytes;
		const overEntries = this.slots.size > this.maxEntries;
		if (!overBytes && !overEntries) return;
		const targetEntries = overEntries ? this.maxEntries - Math.floor(this.maxEntries * 0.05) : Infinity;
		const candidates = [...this.slots].filter(([key]) => key !== keep).sort(([, a], [, b]) => this.rank(a) - this.rank(b));
		for (const [key, slot] of candidates) {
			if (this.bytes <= maxBytes && this.slots.size <= targetEntries) break;
			if (this.options.isPinned?.(key, slot.value)) continue;
			this.slots.delete(key);
			this.bytes -= slot.bytes;
			this.counters.evictions++;
			this.counters.evictedBytes += slot.bytes;
			this.options.onEvict?.(key, slot.value, slot.bytes);
		}
	}

	public stats(): CacheStats {
		return { entries: this.slots.size, usage: this.bytes, limit: this.limit, ...this.counters };
	}

	/** Calls `listener` when anything about the cache changed (reads included, so throttle it). Returns the unsubscribe */
	public onChange(listener: () => void) {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}
	protected changed() {
		for (const listener of this.listeners) listener();
	}
}
