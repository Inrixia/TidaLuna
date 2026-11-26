import path from "path";
import JSZip from "jszip";

import { isInside } from "../isInside";
import { setidEntries, symlinkEntries } from "./zipEntryModes";

/** Refuses a zip that would write outside `destFolder` or that holds a symlink or a setuid/setgid file; returns it loaded. */
export const validateZipEntries = async (zipBuffer: Buffer, destFolder: string) => {
	const zip = await JSZip.loadAsync(zipBuffer);
	for (const filename of Object.keys(zip.files)) {
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
