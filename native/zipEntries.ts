import { mkdir, writeFile } from "fs/promises";
import path from "path";
import JSZip from "jszip";

import { isInside } from "./isInside";

/** Entries a Luna archive may hold. A dist is a few hundred files; thousands is a bomb or a mistake */
const maxEntries = 4096;
/** Bytes a Luna archive may unpack to. A dist is tens of MB, so this is generous and still bounded */
const maxExtractedBytes = 512 * 1024 * 1024;

/**
 * Reads a Luna archive and refuses any entry that would land outside the folder it is unpacked into.
 *
 * The check is on the entry names before anything is written, so a zip carrying `../` (or an absolute path) is rejected
 * whole rather than partly extracted. Used by both the manual update and the automatic one.
 *
 * An archive from a url has no trusted size: the entry count is checked here, the unpacked bytes while extracting, since
 * one entry can unpack to any size and the count alone says nothing about the disk it takes.
 */
export const validateZipEntries = async (zipBuffer: Buffer | Uint8Array, destFolder: string) => {
	const zip = await JSZip.loadAsync(zipBuffer);
	const entries = Object.keys(zip.files);
	if (entries.length > maxEntries) throw new Error(`[UPDATER] Archive has ${entries.length} entries, over the ${maxEntries} limit`);
	for (const filename of entries) {
		const destPath = path.join(destFolder, filename);
		if (!isInside(destFolder, destPath)) throw new Error(`[UPDATER] Zip Slip blocked: unsafe entry "${filename}"`);
	}
	return zip;
};

/**
 * Writes the entries of a zip that `validateZipEntries` has already checked into `destFolder`.
 *
 * The check is repeated per entry rather than trusted to have happened: unpacking is the step that writes to disk, so it
 * is where the guarantee has to hold.
 */
export const extractZip = async (zip: JSZip, destFolder: string) => {
	await mkdir(destFolder, { recursive: true });
	let written = 0;
	for (const [filename, file] of Object.entries(zip.files)) {
		const destPath = path.join(destFolder, filename);
		if (!isInside(destFolder, destPath)) throw new Error(`[UPDATER] Zip Slip blocked: unsafe entry "${filename}"`);
		if (file.dir) {
			await mkdir(destPath, { recursive: true });
			continue;
		}
		const contents = await file.async("nodebuffer");
		written += contents.byteLength;
		if (written > maxExtractedBytes) throw new Error(`[UPDATER] Archive unpacks to over ${maxExtractedBytes} bytes`);
		// Entries are not always sorted, so the parent may not exist yet
		await mkdir(path.dirname(destPath), { recursive: true });
		await writeFile(destPath, contents);
	}
};

/** Check, then unpack: the two steps an archive is always used in, in the order that matters */
export const extractZipEntries = async (zipBuffer: Buffer | Uint8Array, destFolder: string) => {
	const zip = await validateZipEntries(zipBuffer, destFolder);
	await extractZip(zip, destFolder);
};
