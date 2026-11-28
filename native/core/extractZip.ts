import { mkdir, writeFile } from "fs/promises";
import path from "path";
import JSZip from "jszip";

import { isInside } from "../isInside";
import { validateZipEntries } from "./validateZipEntries";

/** Bytes a Luna archive may unpack to. A dist is tens of MB, so this is generous and still bounded */
const maxExtractedBytes = 512 * 1024 * 1024;

/**
 * Writes the entries of a zip that `validateZipEntries` has already checked into `destFolder`.
 *
 * The path check is repeated per entry rather than trusted to have happened: unpacking is the step that writes to disk, so
 * it is where the guarantee has to hold.
 *
 * The archive comes from a url, so what it unpacks to is not trusted either: one entry can expand to any size and the
 * entry count cannot say how much disk that is, so the bytes written are counted here.
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
