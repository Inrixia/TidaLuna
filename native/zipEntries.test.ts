import { mkdtemp, readdir, rm } from "fs/promises";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { extractZip, validateZipEntries } from "./zipEntries";

/**
 * An update archive comes from a url and is unpacked over the Luna install, so its entry names and its size are both
 * attacker-controlled: a `../` entry writes outside the folder, and an archive that unpacks to gigabytes fills the disk.
 *
 * A name like that cannot be produced with `zip.file()`, which sanitises it before writing, so the guard is exercised
 * where it matters: the per-entry check inside extraction, which is the step that writes to disk.
 */
let dest = "";

beforeEach(async () => {
	dest = await mkdtemp(path.join(os.tmpdir(), "luna-zip-entries-"));
});

afterEach(async () => {
	await rm(dest, { recursive: true, force: true }).catch(() => {});
});

const zipOf = async (files: Record<string, string>) => {
	const zip = new JSZip();
	for (const [name, contents] of Object.entries(files)) zip.file(name, contents);
	return zip.generateAsync({ type: "nodebuffer" });
};

/** A zip whose entries report what the test needs: nothing is written until an entry passes the guards */
const stubZip = (files: Record<string, { dir: boolean; async: () => Promise<{ byteLength: number }> }>) => ({ files }) as unknown as JSZip;

describe("validateZipEntries", () => {
	test("accepts an archive whose entries all land inside the folder", async () => {
		const zip = await validateZipEntries(await zipOf({ "injector.mjs": "a", "app/package.json": "{}" }), dest);
		// JSZip records the folder its entries are in as an entry of its own
		expect(Object.keys(zip.files)).toContain("app/package.json");
		expect(Object.keys(zip.files)).toContain("injector.mjs");
	});

	test("refuses a folder of entries that is far larger than a dist", async () => {
		const files: Record<string, string> = {};
		for (let at = 0; at < 4097; at++) files[`f${at}.mjs`] = "";
		await expect(validateZipEntries(await zipOf(files), dest)).rejects.toThrow("entries, over the 4096 limit");
	});
});

describe("extractZip", () => {
	test("refuses an entry that would land outside the folder, before writing anything", async () => {
		const entry = { dir: false, async: async () => Buffer.from("x") };
		await expect(extractZip(stubZip({ "../escape.txt": entry }), dest)).rejects.toThrow("Zip Slip blocked");
		// Nothing reached the disk, in the folder or above it
		expect(await readdir(dest)).toEqual([]);
		expect(await readdir(path.dirname(dest))).not.toContain("escape.txt");
	});

	test("stops when the archive unpacks to more than it may, before writing the entry that crossed the limit", async () => {
		// The entry reports a size the cap cannot allow; the guard reads the size, so nothing has to be allocated
		const huge = { dir: false, async: async () => ({ byteLength: 600 * 1024 * 1024 }) };
		await expect(extractZip(stubZip({ "huge.bin": huge }), dest)).rejects.toThrow("unpacks to over 536870912 bytes");
	});
});
