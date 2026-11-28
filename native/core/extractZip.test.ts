import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractZip, extractZipEntries } from "./extractZip";

/**
 * An update archive comes from a url and is unpacked over the Luna install, so both its entry names and the disk it takes
 * are attacker-controlled: a `../` entry writes outside the folder, and an archive that unpacks to gigabytes fills the
 * disk. A name like that cannot be produced with `zip.file()`, which sanitises it before writing, so the guard is
 * exercised where it matters: the per-entry check inside extraction, which is the step that writes to disk.
 */
let dest = "";

beforeEach(async () => {
	dest = await mkdtemp(path.join(os.tmpdir(), "luna-extract-zip-"));
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

describe("extractZip", () => {
	it("writes the entries a checked archive holds", async () => {
		await extractZipEntries(await zipOf({ "injector.mjs": "console.log(1)", "app/package.json": "{}" }), dest);
		expect(await readFile(path.join(dest, "injector.mjs"), "utf8")).toBe("console.log(1)");
	});

	it("refuses an entry that would land outside the folder, before writing anything", async () => {
		const entry = { dir: false, async: async () => Buffer.from("x") };
		await expect(extractZip(stubZip({ "../escape.txt": entry }), dest)).rejects.toThrow("Zip Slip blocked");
		// Nothing reached the disk, in the folder or above it
		expect(await readdir(dest)).toEqual([]);
		expect(await readdir(path.dirname(dest))).not.toContain("escape.txt");
	});

	it("stops when the archive unpacks to more than it may, before writing the entry that crossed the limit", async () => {
		// The entry reports a size the cap cannot allow; the guard reads the size, so nothing has to be allocated
		const huge = { dir: false, async: async () => ({ byteLength: 600 * 1024 * 1024 }) };
		await expect(extractZip(stubZip({ "huge.bin": huge }), dest)).rejects.toThrow("unpacks to over 536870912 bytes");
	});
});
