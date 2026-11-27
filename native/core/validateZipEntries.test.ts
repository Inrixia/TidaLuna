import { join } from "path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { validateZipEntries } from "./validateZipEntries";

const dest = join(process.cwd(), "dest-app");
const zipOf = async (entries: Record<string, number>) => {
	const zip = new JSZip();
	for (const [name, mode] of Object.entries(entries)) zip.file(name, "x", { unixPermissions: mode });
	return Buffer.from(await zip.generateAsync({ type: "uint8array", platform: "UNIX" }));
};

describe("validateZipEntries", () => {
	it("returns the loaded zip for plain entries", async () => {
		const zip = await validateZipEntries(await zipOf({ "a.txt": 0o100644, "bin/run": 0o100755 }), dest);
		expect(Object.keys(zip.files)).toContain("a.txt");
	});

	it("refuses a symlink", async () => {
		await expect(validateZipEntries(await zipOf({ link: 0o120777 }), dest)).rejects.toThrow(/Symlink blocked: "link"/);
	});

	it("refuses a setuid file", async () => {
		await expect(validateZipEntries(await zipOf({ suid: 0o104755 }), dest)).rejects.toThrow(/setuid\/setgid blocked: "suid"/);
	});
});
