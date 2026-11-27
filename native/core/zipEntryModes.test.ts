import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { setidEntries, symlinkEntries } from "./zipEntryModes";

/** A zip as `zip` on Linux stores it: UNIX entries with their mode, a symlink holding its target as the content */
const zipWith = async (entries: Record<string, { data: string; mode: number }>) => {
	const zip = new JSZip();
	for (const [name, { data, mode }] of Object.entries(entries)) zip.file(name, data, { unixPermissions: mode });
	return Buffer.from(await zip.generateAsync({ type: "uint8array", platform: "UNIX" }));
};

describe("symlinkEntries", () => {
	it("names the entries stored as symlinks", async () => {
		const zip = await JSZip.loadAsync(
			await zipWith({ "a.txt": { data: "a", mode: 0o100644 }, "link": { data: "/etc", mode: 0o120777 }, "bin/run": { data: "x", mode: 0o100755 } }),
		);
		expect(symlinkEntries(zip)).toEqual(["link"]);
	});

	it("finds none in a zip of plain files and folders", async () => {
		const zip = await JSZip.loadAsync(await zipWith({ "a.txt": { data: "a", mode: 0o100644 }, "dir/b.txt": { data: "b", mode: 0o100600 } }));
		expect(symlinkEntries(zip)).toEqual([]);
	});

	it("finds none when the zip carries no modes (made on Windows)", async () => {
		const zip = await JSZip.loadAsync(Buffer.from(await new JSZip().file("a.txt", "a").generateAsync({ type: "uint8array", platform: "DOS" })));
		expect(symlinkEntries(zip)).toEqual([]);
	});
});

describe("setidEntries", () => {
	it("names the entries with a setuid or setgid bit", async () => {
		const zip = await JSZip.loadAsync(
			await zipWith({ "a.txt": { data: "a", mode: 0o100644 }, "suid": { data: "x", mode: 0o104755 }, "sgid": { data: "x", mode: 0o102755 } }),
		);
		expect(setidEntries(zip)).toEqual(["suid", "sgid"]);
	});

	it("finds none in plain files, executables included, or in a zip with no modes", async () => {
		const plain = await JSZip.loadAsync(await zipWith({ "a.txt": { data: "a", mode: 0o100644 }, "bin/run": { data: "x", mode: 0o100755 } }));
		expect(setidEntries(plain)).toEqual([]);
		const dos = await JSZip.loadAsync(Buffer.from(await new JSZip().file("a.txt", "a").generateAsync({ type: "uint8array", platform: "DOS" })));
		expect(setidEntries(dos)).toEqual([]);
	});
});

describe("setidEntries and folders", () => {
	it("ignores a folder stored with the setgid bit", async () => {
		const zip = new JSZip();
		zip.file("plugins/a.txt", "a", { unixPermissions: 0o100644 });
		zip.folder("plugins")!.file("b.txt", "b", { unixPermissions: 0o100644 });
		zip.file("plugins/", "", { dir: true, unixPermissions: 0o042775 });
		const loaded = await JSZip.loadAsync(Buffer.from(await zip.generateAsync({ type: "uint8array", platform: "UNIX" })));
		expect(loaded.files["plugins/"].dir).toBe(true);
		expect(setidEntries(loaded)).toEqual([]);
	});
});
