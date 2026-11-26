import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { symlinkEntries } from "./zipSymlinks";

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
