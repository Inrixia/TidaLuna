import path from "path";
import JSZip from "jszip";

import { isInside } from "./isInside";

/**
 * Reads a Luna archive and refuses any entry that would land outside the folder it is unpacked into.
 *
 * The check is on the entry names before anything is written, so a zip carrying `../` (or an absolute path) is rejected
 * whole rather than partly extracted. Used by both the manual update and the automatic one.
 */
export const validateZipEntries = async (zipBuffer: Buffer | Uint8Array, destFolder: string) => {
	const zip = await JSZip.loadAsync(zipBuffer);
	for (const filename of Object.keys(zip.files)) {
		const destPath = path.join(destFolder, filename);
		if (!isInside(destFolder, destPath)) throw new Error(`[UPDATER] Zip Slip blocked: unsafe entry "${filename}"`);
	}
	return zip;
};
