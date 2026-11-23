// Cache of files in a folder under userData, see Cache.ts for how entries are ranked and evicted. Each entry is a body file plus an `<id>.json`
// sidecar holding the provider's metadata, so the folder can be indexed again on start (an entry without both is dropped).
// What the cache adds over a plain folder:
// - eviction by recency and frequency of reads, kept across restarts (`.access.json`), never by what was written last
// - a limit set by the user (and optionally a share of the free disk space), applied at once when lowered
// - optional memory tier for small bodies read often, so replays don't touch the disk
// - stats and a throttled push of them to the page (`__Luna.cacheStats`) for the cache UI
import electron from "electron";

import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "fs/promises";
import { writeFileSync } from "fs";
import path from "path";

import { Cache, type CacheAccess, type CacheStats } from "./Cache";

const accessFile = ".access.json";

export type DiskCacheOptions<M> = {
	/** Names the cache for the UI, its logs, and its folder in userData (`luna-<name>-cache`) */
	name: string;
	/** Bytes the cache may use when the user set no limit */
	defaultLimit: number;
	/** Largest share of the free disk space (plus what the cache already uses) the cache may take, `undefined` for no cap */
	freeShare?: number;
	/** Bytes of bodies kept in memory for reads (0, the default, reads from disk every time) */
	memoryBytes?: number;
	/** The name of an entry's body file in the folder, `<id>` by default. Must be a plain file name */
	bodyOf?: (id: string, meta: M) => string;
	/** An entry that can't be evicted or cleared now, e.g. it is being read */
	isPinned?: (id: string) => boolean;
	/** Stats of the provider, added to `DiskCacheStats.extra` */
	extraStats?: () => Record<string, unknown>;
};

export type DiskCacheStats = CacheStats & {
	name: string;
	/** The folder, empty before the app is ready */
	path: string;
	defaultLimit: number;
	/** What the user set, `undefined` for the default */
	userLimit?: number;
	/** Counts of the memory tier, if it has one */
	memory?: CacheStats;
	extra?: Record<string, unknown>;
};

type Item<M> = { meta: M; file: string };

export const diskCaches = new Map<string, DiskCache<any>>();

let partId = 0;

export class DiskCache<M extends object> {
	private readonly cache: Cache<Item<M>>;
	private readonly memory?: Cache<Buffer>;
	private userLimit?: number;
	/** Free disk space as of the last refresh */
	private free = Infinity;
	private freeAt = 0;
	private removing = Promise.resolve();
	private dirty = false;
	private flushTimer?: ReturnType<typeof setTimeout>;
	private notifyTimer?: ReturnType<typeof setTimeout>;
	/** Set once the app is ready, as userData is derived from TIDAL's name which native/injector.ts sets after modules load */
	public dir = "";
	/** Resolves once the folder is indexed */
	public readonly ready: Promise<void>;

	public constructor(private readonly options: DiskCacheOptions<M>) {
		this.cache = new Cache<Item<M>>({
			maxBytes: () => this.limit,
			isPinned: (id) => options.isPinned?.(id) ?? false,
			onEvict: (id, item) => this.removeFiles(id, item),
		});
		if (options.memoryBytes) this.memory = new Cache<Buffer>({ maxBytes: options.memoryBytes });
		this.cache.onChange(() => {
			this.dirty = true;
			this.schedule();
		});
		diskCaches.set(options.name, this);
		this.ready = electron.app
			.whenReady()
			.then(() => this.load())
			.catch((err) => console.error(`[Luna.native] [${options.name}] Failed to read the cache folder`, err));
		electron.app.on("before-quit", () => this.flush(true));
	}

	public get name() {
		return this.options.name;
	}
	/** Bytes the cache may use */
	public get limit() {
		const max = this.userLimit ?? this.options.defaultLimit;
		return this.options.freeShare === undefined ? max : Math.min(max, this.options.freeShare * (this.free + this.cache.usage));
	}
	public get size() {
		return this.cache.size;
	}

	public fileOf(name: string) {
		return path.join(this.dir, name);
	}
	private bodyOf(id: string, meta: M) {
		return this.options.bodyOf?.(id, meta) ?? id;
	}

	private async refreshFree() {
		this.freeAt = Date.now();
		try {
			const { bavail, bsize } = await statfs(this.dir);
			this.free = bavail * bsize;
		} catch {}
	}

	// Only entries with a sidecar and a body of the name it gives are kept; orphans (and `.part` files cut off by a crash) are dropped
	private async load() {
		this.dir = path.join(electron.app.getPath("userData"), `luna-${this.options.name}-cache`);
		await mkdir(this.dir, { recursive: true });
		await this.refreshFree();
		const names = new Set(await readdir(this.dir));
		const keep = new Set([accessFile]);
		const access: Record<string, [number, number]> = await readFile(this.fileOf(accessFile), "utf8").then(JSON.parse, () => ({}));
		const found: { id: string; item: Item<M>; bytes: number; access: CacheAccess }[] = [];
		await Promise.all(
			[...names].map(async (name) => {
				if (!name.endsWith(".json") || name === accessFile) return;
				try {
					const id = name.slice(0, -5);
					const meta = <M>JSON.parse(await readFile(this.fileOf(name), "utf8"));
					const file = this.bodyOf(id, meta);
					if (file !== path.basename(file) || !names.has(file)) return;
					const { size, mtimeMs } = await stat(this.fileOf(file));
					if (!(size > 0)) return;
					const [last, crf] = access[id] ?? [mtimeMs, 1];
					found.push({ id, item: { meta, file }, bytes: size, access: { last, crf } });
					keep.add(name).add(file);
				} catch {}
			}),
		);
		// Over the limit only once everything is in, so the lowest ranked of all go and not the first found
		const { maxBytes } = this.cache;
		this.cache.maxBytes = Infinity;
		for (const { id, item, bytes, access } of found) this.cache.set(id, item, bytes, access);
		this.cache.maxBytes = maxBytes;
		this.cache.evict();
		const stale = [...names].filter((name) => !keep.has(name));
		await Promise.all(
			stale.map(async (name) => {
				const info = await stat(this.fileOf(name)).catch(() => undefined);
				if (info === undefined || (name.endsWith(".part") && Date.now() - info.mtimeMs < 60 * 60_000)) return;
				await rm(this.fileOf(name), { force: true }).catch(() => {});
			}),
		);
	}

	private removeFiles(id: string, item: Item<M>) {
		this.memory?.delete(id);
		this.removing = this.removing
			.then(async () => {
				await rm(this.fileOf(id + ".json"), { force: true });
				await rm(this.fileOf(item.file), { force: true });
			})
			.catch((err) => console.error(`[Luna.native] [${this.name}] Failed to delete ${id}`, err));
	}

	public has(id: string) {
		return this.cache.has(id);
	}
	/** An entry's metadata without counting a read */
	public meta(id: string): M | undefined {
		return this.cache.peek(id)?.meta;
	}
	public bytesOf(id: string) {
		return this.cache.bytesOf(id);
	}
	public *ids() {
		yield* this.cache.keys();
	}
	/** The body file's name, `undefined` if not held */
	public fileNameOf(id: string) {
		return this.cache.peek(id)?.file;
	}
	/** Counts a read of `id` that is served from its file directly (`bytes` of it), `false` if it isn't held */
	public touch(id: string, bytes = 0) {
		return this.cache.touch(id, bytes);
	}

	/** An entry and its body, counts a read. `undefined` if not held or the body is gone */
	public async read(id: string): Promise<{ meta: M; body: Buffer } | undefined> {
		await this.ready;
		const item = this.cache.peek(id);
		if (item === undefined) return void this.cache.get(id);
		let body = this.memory?.get(id);
		if (body === undefined) {
			try {
				body = await readFile(this.fileOf(item.file));
			} catch {
				// Deleted from under the cache
				this.cache.delete(id);
				return void this.cache.get(id);
			}
			this.remember(id, body);
		}
		this.cache.touch(id, body.byteLength);
		return { meta: item.meta, body };
	}
	private remember(id: string, body: Buffer) {
		if (this.memory !== undefined && body.byteLength <= this.options.memoryBytes! / 8) this.memory.set(id, body, body.byteLength);
	}

	/** Writes an entry (atomically) and registers it. A new entry counts as read once, a rewrite doesn't */
	public async write(id: string, meta: M, body: Uint8Array | Uint8Array[]) {
		await this.ready;
		const file = this.bodyOf(id, meta);
		await mkdir(this.dir, { recursive: true });
		// Own part file per write, two writes of the same id can overlap
		const part = this.fileOf(`${file}.${++partId}.part`);
		try {
			await writeFile(part, body);
			await rename(part, this.fileOf(file));
		} catch (err) {
			await rm(part, { force: true }).catch(() => {});
			throw err;
		}
		await this.adopt(id, meta);
		const bytes = Array.isArray(body) ? Buffer.concat(body) : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
		this.memory?.delete(id);
		this.remember(id, bytes);
	}
	/** Registers the file `bodyOf(id, meta)` already in the folder, e.g. one a download wrote there. Returns its size, 0 if it is empty or missing */
	public async adopt(id: string, meta: M): Promise<number> {
		await this.ready;
		const file = this.bodyOf(id, meta);
		if (file !== path.basename(file)) throw new Error(`Cache file name ${file} is not a plain name`);
		const size = await stat(this.fileOf(file)).then(
			(info) => info.size,
			() => 0,
		);
		if (size === 0) return 0;
		// A file belongs to one entry
		for (const [otherId, other] of this.cache.entries()) {
			if (otherId === id || other.file !== file) continue;
			this.cache.delete(otherId);
			this.memory?.delete(otherId);
			await rm(this.fileOf(otherId + ".json"), { force: true });
		}
		const old = this.cache.peek(id);
		await writeFile(this.fileOf(id + ".json"), JSON.stringify(meta));
		if (old !== undefined && old.file !== file) await rm(this.fileOf(old.file), { force: true });
		this.cache.set(id, { meta, file }, size);
		if (Date.now() - this.freeAt > 30_000) this.refreshFree();
		await this.removing;
		return size;
	}

	/** Deletes an entry. `false` if it isn't held */
	public async remove(id: string) {
		const item = this.cache.peek(id);
		if (item === undefined) return false;
		this.cache.delete(id);
		this.removeFiles(id, item);
		await this.removing;
		return true;
	}
	/** Deletes every entry that isn't pinned */
	public async clear() {
		await this.ready;
		for (const id of [...this.cache.keys()]) if (!this.options.isPinned?.(id)) await this.remove(id);
	}

	/** Bytes the cache may use, `undefined` for the default. Resolves once what no longer fits is deleted */
	public async setLimit(bytes?: number) {
		await this.ready;
		this.userLimit = bytes || undefined;
		await this.refreshFree();
		this.cache.evict();
		await this.removing;
	}
	public openFolder() {
		return electron.shell.openPath(this.dir);
	}

	public stats(): DiskCacheStats {
		return {
			...this.cache.stats(),
			name: this.name,
			path: this.dir,
			defaultLimit: this.options.defaultLimit,
			userLimit: this.userLimit,
			memory: this.memory?.stats(),
			extra: this.options.extraStats?.(),
		};
	}

	private schedule() {
		this.flushTimer ??= setTimeout(() => this.flush(), 10_000).unref();
		this.notifyTimer ??= setTimeout(() => {
			this.notifyTimer = undefined;
			globalThis.luna?.sendToRender?.("__Luna.cacheStats", this.stats());
		}, 1000).unref();
	}
	/** Keeps what reads ranked entries by, so eviction after a restart still knows what was used */
	private flush(sync = false) {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (!this.dirty || this.dir === "") return;
		this.dirty = false;
		const access: Record<string, [number, number]> = {};
		for (const id of this.cache.keys()) {
			const { last, crf } = this.cache.accessOf(id)!;
			access[id] = [last, crf];
		}
		const json = JSON.stringify(access);
		const file = this.fileOf(accessFile);
		if (sync) return writeFileSync(file, json);
		const part = `${file}.${++partId}.part`;
		writeFile(part, json)
			.then(() => rename(part, file))
			.catch((err) => console.error(`[Luna.native] [${this.name}] Failed to save access times`, err));
	}
}
