// A SQLite database (node:sqlite) of tables of JSON text, one per cache meta backend (see SqliteBackend). Every call is synchronous,
// so state saved while the main process exits (before-quit doesn't wait for promises) is written before it does.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { rmSync } from "fs";

/** The prepared statements of one table, made once as it is opened */
export type SqliteTable = {
	get: StatementSync;
	set: StatementSync;
	del: StatementSync;
	keys: StatementSync;
	entries: StatementSync;
	count: StatementSync;
};

const tableName = /^[\w-]+$/;

export class SqliteDb {
	private readonly tables = new Map<string, SqliteTable>();

	private constructor(
		private readonly db: DatabaseSync,
		/** The database file */
		public readonly file: string,
	) {}

	/**
	 * The SQLite database `file`, `undefined` if Node has no node:sqlite (before 22.13). A database that isn't one or is corrupt is
	 * deleted and made again: it only holds cache state, the caches drop the files it named and fill again
	 */
	public static open(file: string): SqliteDb | undefined {
		let sqlite: typeof import("node:sqlite") | undefined;
		try {
			sqlite = process.getBuiltinModule?.("node:sqlite");
		} catch {}
		if (sqlite === undefined) return;
		try {
			return SqliteDb.openFile(sqlite, file);
		} catch (err) {
			// SQLITE_CORRUPT, SQLITE_NOTADB (or their extended codes). Anything else (e.g. locked) is thrown, the caches keep to memory and the file stays
			if (![11, 26].includes(((<{ errcode?: number }>err).errcode ?? 0) & 0xff)) throw err;
			for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
			return SqliteDb.openFile(sqlite, file);
		}
	}
	private static openFile(sqlite: typeof import("node:sqlite"), file: string): SqliteDb {
		const db = new sqlite.DatabaseSync(file);
		try {
			db.exec(`
				-- Waits for a lock (e.g. a second process opening it) instead of failing at once. First: switching to WAL takes a lock
				PRAGMA busy_timeout = 5000;
				-- Readers never wait on the writer, a write appends to the log instead of rewriting pages
				PRAGMA journal_mode = WAL;
				-- No fsync per write in WAL mode: an app crash keeps every write, a power cut may lose the last few, never corrupts
				PRAGMA synchronous = NORMAL;
				-- The log is cut back to this after a checkpoint, a large state written often would otherwise leave it at its peak size
				PRAGMA journal_size_limit = ${32 * 1024 ** 2};
				PRAGMA temp_store = MEMORY;
			`);
			// Catches a corrupt file now rather than on the first read. Damaged pages don't throw, they are described in place of "ok"
			const { quick_check } = <{ quick_check: string }>db.prepare("PRAGMA quick_check").get();
			if (quick_check !== "ok") throw Object.assign(new Error(`Corrupt cache database: ${quick_check}`), { errcode: 11 });
		} catch (err) {
			db.close();
			throw err;
		}
		return new SqliteDb(db, file);
	}

	/** The table `name`, made if there is none. A name is letters, digits, `_` and `-` */
	public table(name: string): SqliteTable {
		let table = this.tables.get(name);
		if (table !== undefined) return table;
		if (!tableName.test(name)) throw new Error(`Table name ${name} isn't letters, digits, _ and -`);
		const sql = `"kv_${name}"`;
		this.db.exec(`CREATE TABLE IF NOT EXISTS ${sql} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
		// Prepared once per table as it is opened, not per call. Not at module load: a statement belongs to its open database
		table = {
			get: this.db.prepare(`SELECT value FROM ${sql} WHERE key = ?`),
			set: this.db.prepare(`INSERT OR REPLACE INTO ${sql} (key, value) VALUES (?, ?)`),
			del: this.db.prepare(`DELETE FROM ${sql} WHERE key = ?`),
			keys: this.db.prepare(`SELECT key FROM ${sql}`),
			entries: this.db.prepare(`SELECT key, value FROM ${sql}`),
			count: this.db.prepare(`SELECT COUNT(*) AS count FROM ${sql}`),
		};
		this.tables.set(name, table);
		return table;
	}

	public close() {
		// Updates the query planner's statistics, then checkpoints the log into the database and deletes it
		try {
			this.db.exec("PRAGMA optimize");
		} finally {
			this.db.close();
		}
	}
}
