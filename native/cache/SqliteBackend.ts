import type { BackendStats, CacheStoreBackendBase } from "../../cache";
import type { SqliteDb, SqliteTable } from "./SqliteDb";

/** A sync meta backend: JSON values in one table of a `SqliteDb` */
export class SqliteBackend implements CacheStoreBackendBase<unknown, unknown, true> {
	public readonly sync = true;
	private readonly table: SqliteTable;
	private reads = 0;
	private writes = 0;
	private errors = 0;

	public constructor(
		private readonly db: SqliteDb,
		name: string,
	) {
		this.table = db.table(name);
	}

	public get(key: string): unknown {
		this.reads++;
		const json = <string | undefined>this.table.get.get(key)?.value;
		return json === undefined ? undefined : JSON.parse(json);
	}
	public set(key: string, data: unknown): void {
		this.writes++;
		try {
			this.table.set.run(key, JSON.stringify(data));
		} catch (err) {
			this.errors++;
			throw err;
		}
	}
	public del(key: string): void {
		this.table.del.run(key);
	}
	public keys(): Iterable<string> {
		return this.table.keys.all().map(({ key }) => <string>key);
	}
	public entries(): Iterable<[string, unknown]> {
		return this.table.entries.all().map(({ key, value }): [string, unknown] => [<string>key, JSON.parse(<string>value)]);
	}
	public stats(): BackendStats {
		return {
			kind: "sqlite",
			entries: Number((<{ count: number }>this.table.count.get()).count),
			reads: this.reads,
			writes: this.writes,
			errors: this.errors,
			location: this.db.file,
		};
	}
}
