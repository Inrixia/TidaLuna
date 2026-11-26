import type JSZip from "jszip";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Names of the entries a zip stores as symbolic links. JSZip writes such an entry as a plain file, but `unzip` (the elevated
 * Linux install) recreates the link, so a link in an update zip is refused before anything is extracted.
 */
export const symlinkEntries = (zip: JSZip): string[] =>
	Object.values(zip.files)
		.filter((file) => file.unixPermissions !== null && (Number(file.unixPermissions) & S_IFMT) === S_IFLNK)
		.map((file) => file.name);
