import { createReadStream, createWriteStream, mkdirSync } from "fs";
import { lstat, mkdir, readdir, readFile, rename, rmdir, stat, statfs, unlink, writeFile } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import type { BackendStats, CacheMeta, CacheStoreBackendBase, ReconcileResult, StreamRange } from "../../cache";
import { resolveInside } from "./FsBackend.paths";

/** What the data backend needs in a meta: the file of the value, relative to the folder (`/` between subfolders) */
export type FsMeta = { path: string };

const freeRefreshMs = 30_000;
let partId = 0;

/**
 * A data backend keeping each value as a file at `meta.path` in `dir`, subfolders allowed. Every path is sanitized and kept inside `dir`
 * (see `resolveInside`), a delete names exactly one file and never recurses. Streams read straight from the file
 */
export class FsBackend<X extends object = {}> implements CacheStoreBackendBase<Uint8Array, FsMeta & X, false> {
	public readonly sync = false;
	/** Bytes of each file it knows (wrote or found in `reconcile`) by its path in the folder */
	private readonly fileSizes = new Map<string, number>();
	/** Readers open now by key, which pin their entry */
	private readonly readers = new Map<string, number>();
	private reads = 0;
	private writes = 0;
	private errors = 0;
	private freeBytes?: number;
	private freeAt = 0;

	public constructor(public readonly dir: string) {
		mkdirSync(dir, { recursive: true });
	}

	private fileOf(meta?: Partial<FsMeta>) {
		return resolveInside(this.dir, meta?.path);
	}

	public async get(_key: string, meta?: CacheMeta<FsMeta & X>): Promise<Uint8Array | undefined> {
		const file = this.fileOf(meta);
		try {
			const buffer = await readFile(file);
			this.reads++;
			// A plain Uint8Array, not the Buffer node gives
			return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		} catch (err) {
			if ((<NodeJS.ErrnoException>err).code === "ENOENT") return;
			this.errors++;
			throw err;
		}
	}

	public async getStream(key: string, meta?: CacheMeta<FsMeta & X>, range: StreamRange = {}): Promise<ReadableStream<Uint8Array> | undefined> {
		const file = this.fileOf(meta);
		try {
			await stat(file);
		} catch (err) {
			if ((<NodeJS.ErrnoException>err).code === "ENOENT") return;
			throw err;
		}
		this.reads++;
		if (range.end !== undefined && range.end < (range.start ?? 0)) return new ReadableStream({ start: (controller) => controller.close() });
		// createReadStream's end is inclusive, as in a range
		const reading = createReadStream(file, { start: range.start, end: range.end, signal: range.signal });
		this.readers.set(key, (this.readers.get(key) ?? 0) + 1);
		// close comes after end, error and a cancel (which destroys it)
		reading.once("close", () => {
			const left = (this.readers.get(key) ?? 1) - 1;
			if (left > 0) this.readers.set(key, left);
			else this.readers.delete(key);
		});
		return <ReadableStream<Uint8Array>>Readable.toWeb(reading);
	}

	/** Writes through a part file of its own, so a crash leaves the old file and two writes of one file can overlap */
	private async writeAtomic(meta: Partial<FsMeta> | undefined, write: (part: string) => Promise<unknown>): Promise<number> {
		const file = this.fileOf(meta);
		const part = `${file}.${++partId}.part`;
		try {
			await mkdir(path.dirname(file), { recursive: true });
			await write(part);
			const { size } = await stat(part);
			await rename(part, file);
			this.writes++;
			this.fileSizes.set(this.relative(file), size);
			return size;
		} catch (err) {
			this.errors++;
			await unlink(part).catch(() => {});
			throw err;
		}
	}
	public async set(_key: string, data: Uint8Array, meta?: CacheMeta<FsMeta & X>): Promise<void> {
		await this.writeAtomic(meta, (part) => writeFile(part, data));
	}
	public setStream(_key: string, dataStream: ReadableStream<Uint8Array>, meta?: CacheMeta<FsMeta & X>): Promise<number> {
		return this.writeAtomic(meta, (part) => pipeline(Readable.fromWeb(<import("stream/web").ReadableStream>dataStream), createWriteStream(part)));
	}

	public async del(_key: string, meta?: CacheMeta<FsMeta & X>): Promise<void> {
		await this.unlinkFile(this.fileOf(meta));
	}
	/** Deletes the one file at `relativePath` in the folder (never a directory or a symlink's target), and the folders it leaves empty. `false` if there was no file */
	public deleteFile(relativePath: string): Promise<boolean> {
		return this.unlinkFile(resolveInside(this.dir, relativePath));
	}
	private async unlinkFile(file: string): Promise<boolean> {
		try {
			if (!(await lstat(file)).isFile()) return false;
			await unlink(file);
		} catch (err) {
			if ((<NodeJS.ErrnoException>err).code === "ENOENT") return false;
			this.errors++;
			throw err;
		}
		this.fileSizes.delete(this.relative(file));
		// Non-recursive: a folder with anything left in it stays
		const root = path.resolve(this.dir);
		for (let parent = path.dirname(file); parent !== root && parent.startsWith(root + path.sep); parent = path.dirname(parent)) {
			try {
				await rmdir(parent);
			} catch {
				break;
			}
		}
		return true;
	}

	/** Every file in the folder, as paths relative to it. Deletes `.part` files, which a crash cut off: nothing of ours is writing yet */
	private async walk(folder = ""): Promise<string[]> {
		const found: string[] = [];
		for (const entry of await readdir(path.join(this.dir, folder), { withFileTypes: true })) {
			const relativePath = folder === "" ? entry.name : `${folder}/${entry.name}`;
			if (entry.isDirectory()) found.push(...(await this.walk(relativePath)));
			else if (!entry.isFile()) continue;
			else if (entry.name.endsWith(".part")) await this.deleteFile(relativePath).catch(() => {});
			else found.push(relativePath);
		}
		return found;
	}
	public async reconcile(metas: ReadonlyMap<string, CacheMeta<FsMeta & X>>): Promise<ReconcileResult> {
		const files = new Set(await this.walk());
		const missing: string[] = [];
		const named = new Set<string>();
		for (const [key, meta] of metas) {
			let relativePath: string;
			try {
				relativePath = this.relative(this.fileOf(meta));
			} catch {
				missing.push(key);
				continue;
			}
			if (files.has(relativePath)) named.add(relativePath);
			else missing.push(key);
		}
		const orphans = [...files].filter((file) => !named.has(file));
		await Promise.all(
			[...files].map(async (file) => {
				try {
					this.fileSizes.set(file, (await stat(path.join(this.dir, file))).size);
				} catch {}
			}),
		);
		this.refreshFree();
		return { missing, orphans };
	}
	/** A file's path in the folder with `/` between folders, as `walk` gives */
	private relative(file: string) {
		return path.relative(path.resolve(this.dir), file).split(path.sep).join("/");
	}

	public async bytesOf(_key: string, meta?: CacheMeta<FsMeta & X>): Promise<number | undefined> {
		try {
			return (await stat(this.fileOf(meta))).size;
		} catch (err) {
			if ((<NodeJS.ErrnoException>err).code !== "ENOENT") throw err;
		}
	}
	public pinned(key: string): boolean {
		return this.readers.has(key);
	}

	/** Free disk space is read at most every 30s, the last one is in the stats */
	private refreshFree() {
		if (Date.now() - this.freeAt < freeRefreshMs) return;
		this.freeAt = Date.now();
		statfs(this.dir).then(
			({ bavail, bsize }) => (this.freeBytes = bavail * bsize),
			() => {},
		);
	}
	public stats(): BackendStats {
		this.refreshFree();
		let fileBytes = 0;
		for (const size of this.fileSizes.values()) fileBytes += size;
		return {
			kind: "files",
			entries: this.fileSizes.size,
			reads: this.reads,
			writes: this.writes,
			errors: this.errors,
			location: this.dir,
			fileBytes,
			freeBytes: this.freeBytes,
		};
	}
}
