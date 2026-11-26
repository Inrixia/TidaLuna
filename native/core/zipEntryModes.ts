import type JSZip from "jszip";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_ISUID_ISGID = 0o6000;

/**
 * Names of the entries a zip stores as symbolic links. JSZip writes such an entry as a plain file, but `unzip` (the elevated
 * Linux install) recreates the link, so a link in an update zip is refused before anything is extracted.
 */
export const symlinkEntries = (zip: JSZip): string[] =>
	Object.values(zip.files)
		.filter((file) => file.unixPermissions !== null && (Number(file.unixPermissions) & S_IFMT) === S_IFLNK)
		.map((file) => file.name);

/**
 * Names of the files that carry a setuid or setgid bit. Info-ZIP `unzip` drops those bits unless run with `-K`, which the
 * script does not use, so this is a second line: an update zip has no reason to ask for them. Folders are skipped: a zip
 * built inside a setgid directory stores its folders with the bit, which is harmless and must not block the update.
 */
export const setidEntries = (zip: JSZip): string[] =>
	Object.values(zip.files)
		.filter((file) => !file.dir && file.unixPermissions !== null && (Number(file.unixPermissions) & S_ISUID_ISGID) !== 0)
		.map((file) => file.name);
