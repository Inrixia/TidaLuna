import { createHash } from "crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import path from "path";

import type { BackendStats, CacheStoreBackendBase } from "../../cache";

type JsonEntry = { key: string; data: unknown };

/** A sync meta backend for where Node lacks node:sqlite (before 22.13): a `<sha256>.json` file per key in `dir` holding `{ key, data }`, written through a part file so a crash leaves the old one and long URL keys stay within 255-byte name limits */
export class JsonFilesBackend implements CacheStoreBackendBase<unknown, unknown, true> {
	public readonly sync = true;
	private reads = 0;
	private writes = 0;
	private errors = 0;

	public constructor(private readonly dir: string) {
		mkdirSync(dir, { recursive: true });
	}

	private fileOf(key: string) {
		return path.join(this.dir, `${createHash("sha256").update(key).digest("hex")}.json`);
	}

	public get(key: string): unknown {
		this.reads++;
		try {
			const entry = <JsonEntry>JSON.parse(readFileSync(this.fileOf(key), "utf8"));
			return entry.key === key ? entry.data : undefined;
		} catch (err) {
			if ((<NodeJS.ErrnoException>err).code !== "ENOENT") {
				this.errors++;
				throw err;
			}
		}
	}
	public set(key: string, data: unknown): void {
		this.writes++;
		const file = this.fileOf(key);
		const part = `${file}.part`;
		try {
			writeFileSync(part, JSON.stringify(<JsonEntry>{ key, data }));
			renameSync(part, file);
		} catch (err) {
			this.errors++;
			throw err;
		}
	}
	/** Deletes the one file of `key`, only if it is a file */
	public del(key: string): void {
		const file = this.fileOf(key);
		try {
			if (!lstatSync(file).isFile()) return;
			unlinkSync(file);
		} catch (err) {
			if ((<NodeJS.ErrnoException>err).code !== "ENOENT") throw err;
		}
	}
	public keys(): string[] {
		return this.entries().map(([key]) => key);
	}
	public entries(): [string, unknown][] {
		const entries: [string, unknown][] = [];
		for (const name of readdirSync(this.dir)) {
			if (!name.endsWith(".json")) continue;
			try {
				const entry = <JsonEntry>JSON.parse(readFileSync(path.join(this.dir, name), "utf8"));
				if (entry.data !== undefined) entries.push([entry.key, entry.data]);
			} catch (err) {
				if ((<NodeJS.ErrnoException>err).code !== "ENOENT") {
					this.errors++;
					throw err;
				}
			}
		}
		return entries;
	}
	public stats(): BackendStats {
		const entries = readdirSync(this.dir).filter((name) => name.endsWith(".json")).length;
		return { kind: "jsonFiles", entries, reads: this.reads, writes: this.writes, errors: this.errors, location: this.dir };
	}
}
