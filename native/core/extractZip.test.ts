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

describe("extractZip", () => {
	it("writes the entries a checked archive holds", async () => {
		await extractZipEntries(await zipOf({ "injector.mjs": "console.log(1)", "app/package.json": "{}" }), dest);
		expect(await readFile(path.join(dest, "injector.mjs"), "utf8")).toBe("console.log(1)");
		expect(await readFile(path.join(dest, "app", "package.json"), "utf8")).toBe("{}");
	});

	it("refuses an entry that would land outside the folder", async () => {
		// The name is checked before the entry is opened, so this needs no readable contents to be refused
		const zip = { files: { "../escape.txt": { dir: false } } } as unknown as JSZip;
		await expect(extractZip(zip, dest)).rejects.toThrow("Zip Slip blocked");
		expect(await readdir(dest)).toEqual([]);
		expect(await readdir(path.dirname(dest))).not.toContain("escape.txt");
	});

	it("stops partway through an archive that unpacks to more than it may, and leaves no half written file", async () => {
		// A real archive with a small limit: the cap is what it has to be here, not something the test has to allocate
		const zip = await JSZip.loadAsync(await zipOf({ "big.bin": "x".repeat(4096) }));
		await expect(extractZip(zip, dest, 32)).rejects.toThrow("unpacks to over 32 bytes");
		expect(await readdir(dest)).toEqual([]);
	});
});
