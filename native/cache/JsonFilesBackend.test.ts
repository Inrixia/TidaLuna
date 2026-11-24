import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CacheStore } from "../../cache";
import { backendContract } from "../../test/backendContract";
import { JsonFilesBackend } from "./JsonFilesBackend";

const tmp = await mkdtemp(path.join(os.tmpdir(), "luna-jsonfiles-"));
afterAll(() => rm(tmp, { recursive: true }));

let n = 0;
const newDir = () => path.join(tmp, `d${++n}`);

backendContract<unknown>("JsonFilesBackend", {
	make: () => new JsonFilesBackend(newDir()),
	value: (value) => ({ value, nested: [value] }),
});

describe("JsonFilesBackend keys", () => {
	it("round-trips the settings key and keys with / : ? . *", () => {
		const backend = new JsonFilesBackend(newDir());
		const keys = [CacheStore.settingsKey, "https://a.b/c?d=e&f=*", "a/b", "..", ".", "100%", "x.json"];
		for (const [i, key] of keys.entries()) backend.set(key, { i });
		expect([...backend.keys()].sort()).toEqual([...keys].sort());
		for (const [i, key] of keys.entries()) expect(backend.get(key)).toEqual({ i });
		expect(new Map(backend.entries()).get("a/b")).toEqual({ i: 2 });
	});

	it("names are safe on Windows: no reserved characters and no part files left", async () => {
		const dir = newDir();
		const backend = new JsonFilesBackend(dir);
		backend.set("a:b?c*d/e\0", 1);
		const names = await readdir(dir);
		expect(names).toHaveLength(1);
		expect(names[0]).not.toMatch(/[<>:"/\\|?*\0]/);
	});

	it("reopened over the same folder it reads back what was written", () => {
		const dir = newDir();
		new JsonFilesBackend(dir).set("k", { a: 1 });
		expect(new JsonFilesBackend(dir).get("k")).toEqual({ a: 1 });
	});

	it("handles keys longer than 255 bytes without hitting filename length limits", () => {
		const backend = new JsonFilesBackend(newDir());
		const longKey = `https://api.tidal.com/v1/pages/home?${"filter=abcdefghij&".repeat(30)}`;
		expect(longKey.length).toBeGreaterThan(400);
		backend.set(longKey, { ok: true });
		expect(backend.get(longKey)).toEqual({ ok: true });
		expect(backend.keys()).toEqual([longKey]);
	});
});
