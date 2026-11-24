import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CacheStore } from "../../cache";
import { backendContract } from "../../test/backendContract";
import { FsBackend } from "./FsBackend";
import { SqliteBackend } from "./SqliteBackend";
import { SqliteDb } from "./SqliteDb";

const tmp = await mkdtemp(path.join(os.tmpdir(), "luna-sqlite-"));
const opened: SqliteDb[] = [];
afterAll(async () => {
	// Windows can't delete an open database
	for (const db of opened) {
		try {
			db.close();
		} catch {}
	}
	await rm(tmp, { recursive: true, force: true });
});

let n = 0;
const newFile = () => path.join(tmp, `db${++n}.sqlite`);
const open = (file: string) => {
	const db = SqliteDb.open(file);
	if (db !== undefined) opened.push(db);
	return db;
};
const hasSqlite = open(newFile()) !== undefined;

describe.skipIf(!hasSqlite)("SqliteBackend", () => {
	backendContract<unknown>("SqliteBackend", {
		make: () => new SqliteBackend(open(newFile())!, "t"),
		value: (value) => ({ value, nested: [value] }),
	});

	it("reopened it reads back values, tables are apart", () => {
		const file = newFile();
		const db = open(file)!;
		new SqliteBackend(db, "a").set("k", { a: 1 });
		new SqliteBackend(db, "b").set("k", { b: 1 });
		db.close();
		const reopened = open(file)!;
		expect(new SqliteBackend(reopened, "a").get("k")).toEqual({ a: 1 });
		expect(new SqliteBackend(reopened, "b").get("k")).toEqual({ b: 1 });
		expect(new SqliteBackend(reopened, "a").stats()).toMatchObject({ kind: "sqlite", location: file, entries: 1 });
	});

	it("rejects a table name that isn't letters, digits, _ and -", () => {
		expect(() => open(newFile())!.table('a"b')).toThrow("Table name");
	});

	it("a file that isn't a database is made again", async () => {
		const file = newFile();
		await writeFile(file, "this is not a sqlite database, ".repeat(200));
		const backend = new SqliteBackend(open(file)!, "t");
		backend.set("k", 1);
		expect(backend.get("k")).toBe(1);
	});

	it("a CacheStore over SqliteBackend and FsBackend gets its value back from new stores over the same files", async () => {
		const file = newFile();
		const dir = path.join(tmp, `files${n}`);
		const storeOver = (db: SqliteDb) => new CacheStore({ meta: new SqliteBackend(db, "c"), data: new FsBackend(dir), saveDelayMs: 0 });
		const db = open(file)!;
		const first = storeOver(db);
		const now = Date.now();
		const data = new Uint8Array([1, 2, 3]);
		await first.set("k", data, <any>{ path: "k.bin", bytes: 3, crf: 1, last: now, written: now });
		await first.close();
		db.close();

		const second = storeOver(open(file)!);
		await second.ready;
		expect(second.has("k")).toBe(true);
		expect(await second.get("k")).toEqual(data);
	});
});
