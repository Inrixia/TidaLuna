import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { bytesStream, readAll, type CacheMeta } from "../../cache";
import { backendContract } from "../../test/backendContract";
import { FsBackend, type FsMeta } from "./FsBackend";

const tmp = await mkdtemp(path.join(os.tmpdir(), "luna-fsbackend-"));
afterAll(() => rm(tmp, { recursive: true }));

let n = 0;
const newDir = () => path.join(tmp, `d${++n}`);
const metaOf = (file: string): CacheMeta<FsMeta> => ({ path: file, bytes: 0, crf: 1, last: 1, written: 1 });
const bytes = (...values: number[]) => new Uint8Array(values);

backendContract<Uint8Array, FsMeta>("FsBackend", {
	make: () => new FsBackend(newDir()),
	value: (value) => new Uint8Array([value, value + 1, value + 2, value + 3]),
	meta: (key) => ({ path: key }),
});

describe("FsBackend paths", () => {
	it.each([
		["a missing path", undefined],
		["an empty path", ""],
		["..", ".."],
		["a .. segment", "a/../b"],
		["an absolute path", path.resolve(tmp, "x")],
		["a leading slash", "/x"],
		["an empty segment", "a//b"],
		["a segment that sanitizes to nothing", "a/./b"],
	])("throws for %s", async (_what, file) => {
		const backend = new FsBackend(newDir());
		const meta = <CacheMeta<FsMeta>>{ ...metaOf(""), path: file };
		await expect(backend.set("k", bytes(1), meta)).rejects.toThrow();
		await expect(backend.get("k", meta)).rejects.toThrow();
		await expect(backend.del("k", meta)).rejects.toThrow();
		await expect(backend.get("k", { ...metaOf("x"), path: undefined as any })).rejects.toThrow();
		expect(() => backend.deleteFile(file as string)).toThrow();
	});

	it("sanitizes each segment of a path", async () => {
		const dir = newDir();
		const backend = new FsBackend(dir);
		await backend.set("k", bytes(1), metaOf("a<b>/c?d"));
		expect(await readdir(path.join(dir, "ab"))).toEqual(["cd"]);
	});

	it("makes subfolders for a write and removes the empty ones after a delete, never the folder itself", async () => {
		const dir = newDir();
		const backend = new FsBackend(dir);
		const meta = metaOf("a/b/c");
		await backend.set("k", bytes(1), meta);
		expect(await readdir(path.join(dir, "a", "b"))).toEqual(["c"]);
		await backend.set("k2", bytes(2), metaOf("a/other"));
		await backend.del("k", meta);
		// a/b was left empty, a still holds `other`
		expect(await readdir(path.join(dir, "a"))).toEqual(["other"]);
		await backend.deleteFile("a/other");
		expect(await readdir(dir)).toEqual([]);
	});

	it("deleteFile refuses a directory", async () => {
		const dir = newDir();
		const backend = new FsBackend(dir);
		await mkdir(path.join(dir, "sub"));
		await writeFile(path.join(dir, "sub", "f"), "x");
		expect(await backend.deleteFile("sub")).toBe(false);
		expect(await readdir(path.join(dir, "sub"))).toEqual(["f"]);
		expect(await backend.deleteFile("missing")).toBe(false);
	});

	it("deleteFile never follows a symlink to its target", async (ctx) => {
		const dir = newDir();
		const backend = new FsBackend(dir);
		const target = path.join(tmp, "target-dir");
		await mkdir(target);
		try {
			await symlink(target, path.join(dir, "link"), "junction");
		} catch {
			return ctx.skip();
		}
		await backend.deleteFile("link");
		expect((await stat(target)).isDirectory()).toBe(true);
	});
});

describe("FsBackend files", () => {
	it("a failed setStream leaves no file and no .part", async () => {
		const dir = newDir();
		const backend = new FsBackend(dir);
		const failing = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes(1, 2, 3));
				controller.error(new Error("source failed"));
			},
		});
		await expect(backend.setStream("k", failing, metaOf("sub/f"))).rejects.toThrow("source failed");
		expect(await readdir(dir, { recursive: true }).then((names) => names.filter((name) => !name.endsWith("sub")))).toEqual([]);
	});

	it("setStream resolves the bytes written and keeps the old file until it is done", async () => {
		const backend = new FsBackend(newDir());
		const meta = metaOf("f");
		await backend.set("k", bytes(9), meta);
		expect(await backend.setStream("k", bytesStream(bytes(1, 2, 3)), meta)).toBe(3);
		expect(await backend.get("k", meta)).toEqual(bytes(1, 2, 3));
		expect(await backend.bytesOf("k", meta)).toBe(3);
		expect(await backend.bytesOf("k", metaOf("nope"))).toBeUndefined();
	});

	it("streams a range, an open end and an empty range", async () => {
		const backend = new FsBackend(newDir());
		const meta = metaOf("f");
		await backend.set("k", bytes(0, 1, 2, 3, 4), meta);
		expect(await readAll((await backend.getStream("k", meta, { start: 1, end: 3 }))!)).toEqual(bytes(1, 2, 3));
		expect(await readAll((await backend.getStream("k", meta, { start: 3 }))!)).toEqual(bytes(3, 4));
		expect(await readAll((await backend.getStream("k", meta, { start: 3, end: 2 }))!)).toEqual(bytes());
		expect(await backend.getStream("k", metaOf("nope"))).toBeUndefined();
	});

	it("is pinned while a reader is open", async () => {
		const backend = new FsBackend(newDir());
		const meta = metaOf("f");
		await backend.set("k", bytes(0, 1, 2, 3), meta);
		expect(backend.pinned("k")).toBe(false);
		const stream = (await backend.getStream("k", meta))!;
		expect(backend.pinned("k")).toBe(true);
		await readAll(stream);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(backend.pinned("k")).toBe(false);
		const cancelled = (await backend.getStream("k", meta))!;
		await cancelled.cancel();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(backend.pinned("k")).toBe(false);
	});

	it("reconcile deletes .part files, reports orphans and missing metas", async () => {
		const dir = newDir();
		const backend = new FsBackend(dir);
		await backend.set("kept", bytes(1), metaOf("kept"));
		await mkdir(path.join(dir, "sub"));
		await writeFile(path.join(dir, "sub", "orphan"), "x");
		await writeFile(path.join(dir, "kept.7.part"), "x");
		const metas = new Map([
			["kept", metaOf("kept")],
			["gone", metaOf("gone")],
		]);
		const result = await new FsBackend(dir).reconcile(metas);
		expect(result).toEqual({ missing: ["gone"], orphans: ["sub/orphan"] });
		expect((await readdir(dir)).sort()).toEqual(["kept", "sub"]);
	});

	it("stats say where it keeps files and how big they are", async () => {
		const dir = newDir();
		const backend = new FsBackend(dir);
		await backend.set("k", bytes(1, 2, 3), metaOf("f"));
		await backend.reconcile(new Map([["k", metaOf("f")]]));
		expect(backend.stats()).toMatchObject({ kind: "files", entries: 1, location: dir, fileBytes: 3 });
	});
});
