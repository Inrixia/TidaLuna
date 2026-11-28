import { createWriteStream } from "fs";
import { mkdir, unlink } from "fs/promises";
import path from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import JSZip from "jszip";

import { isInside } from "../isInside";
import { validateZipEntries } from "./validateZipEntries";

/** Bytes a Luna archive may unpack to. A dist is tens of MB, so this is generous and still bounded */
export const maxExtractedBytes = 512 * 1024 * 1024;

/**
 * Writes the entries of a zip that `validateZipEntries` has already checked into `destFolder`.
 *
 * The path check is repeated per entry rather than trusted to have happened: unpacking is the step that writes to disk, so
 * it is where the guarantee has to hold.
 *
 * The archive comes from a url, so what it unpacks to is not trusted either. Entries are streamed and counted as they
 * decompress, because one entry can expand to any size: buffering it first would meet the ceiling as an allocation, which
 * is a crash rather than a refusal.
 */
export const extractZip = async (zip: JSZip, destFolder: string, limitBytes = maxExtractedBytes) => {
	await mkdir(destFolder, { recursive: true });
	let written = 0;
	for (const [filename, file] of Object.entries(zip.files)) {
		const destPath = path.join(destFolder, filename);
		if (!isInside(destFolder, destPath)) throw new Error(`[UPDATER] Zip Slip blocked: unsafe entry "${filename}"`);
		if (file.dir) {
			await mkdir(destPath, { recursive: true });
			continue;
		}
		// Entries are not always sorted, so the parent may not exist yet
		await mkdir(path.dirname(destPath), { recursive: true });
		const counted = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				written += chunk.byteLength;
				if (written > limitBytes) return callback(new Error(`[UPDATER] Archive unpacks to over ${limitBytes} bytes`));
				callback(null, chunk);
			},
		});
		try {
			await pipeline(file.nodeStream(), counted, createWriteStream(destPath));
		} catch (err) {
			// Half an entry is not an install: the caller keeps the folder for its own cleanup, so this file goes now
			await unlink(destPath).catch(() => {});
			throw err;
		}
	}
};

/** Check, then unpack: the two steps an archive is always used in, in the order that matters */
export const extractZipEntries = async (zipBuffer: Buffer | Uint8Array, destFolder: string) => {
	const zip = await validateZipEntries(zipBuffer, destFolder);
	await extractZip(zip, destFolder);
};
