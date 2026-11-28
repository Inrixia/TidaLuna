import path from "path";
import JSZip from "jszip";

import { isInside } from "../isInside";
import { setidEntries, symlinkEntries } from "./zipEntryModes";

/** Entries a Luna archive may hold. A dist is a few hundred files; thousands is a bomb or a mistake */
const maxEntries = 4096;

/** Refuses a zip that would write outside `destFolder`, or that holds a symlink or a setuid/setgid file; returns it loaded. */
export const validateZipEntries = async (zipBuffer: Buffer | Uint8Array, destFolder: string) => {
	const zip = await JSZip.loadAsync(zipBuffer);
	const entries = Object.keys(zip.files);
	if (entries.length > maxEntries) throw new Error(`[UPDATER] Archive has ${entries.length} entries, over the ${maxEntries} limit`);
	for (const filename of entries) {
		const destPath = path.join(destFolder, filename);
		if (!isInside(destFolder, destPath)) {
			throw new Error(`[UPDATER] Zip Slip blocked: unsafe entry "${filename}"`);
		}
	}
	const links = symlinkEntries(zip);
	if (links.length > 0) throw new Error(`[UPDATER] Symlink blocked: "${links[0]}"`);
	const setid = setidEntries(zip);
	if (setid.length > 0) throw new Error(`[UPDATER] setuid/setgid blocked: "${setid[0]}"`);
	return zip;
};
