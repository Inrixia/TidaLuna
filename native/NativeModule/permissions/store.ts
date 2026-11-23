import { app, safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

/**
 * Answers hold for the plugin they were given to only, never for another plugin with the same code.
 * - allow: this build of the file only (its code hash)
 * - allowUpdates: any build the plugin's url serves, until the plugin is reinstalled or this is revoked
 * - deny: until the plugin is reinstalled or this is revoked
 */
export type PermissionAnswer = "deny" | "allow" | "allowUpdates";

/** Whether a native file may run in the main process, as the user answered */
export type NativeRecord = {
	/** The plugin url, checked against what it serves (see verifySource.ts). Undefined when it could not be checked */
	url?: string;
	/** The url the renderer named for the plugin */
	claimedUrl?: string;
	fileName: string;
	answer: PermissionAnswer;
	/** Code hashes this answer was given or checked for. An allow holds for these only */
	hashes: string[];
	/** Modules the source named when it was answered. Shown in settings, they limit nothing */
	modules: string[];
};

type PermissionStore = {
	version: 2;
	natives: Record<string, NativeRecord>;
};

/**
 * A file of a plugin url, or one build of it when the url could not be checked (of the url the renderer named, if
 * any). Answers belong to one plugin: a plugin of the same name from another store, or another plugin with the same
 * code, never shares them.
 */
export const recordKey = (fileName: string, hash: string, url?: string, claimedUrl?: string) =>
	url !== undefined ? `${url}::${fileName}` : claimedUrl !== undefined ? `${claimedUrl}::${fileName}@${hash}` : `${fileName}@${hash}`;

const STORE_FILE = "luna-native-permissions.enc";
const filePath = () => path.join(app.getPath("userData"), STORE_FILE);

let store: PermissionStore | undefined;
export const getStore = (): PermissionStore => {
	if (store !== undefined) return store;
	try {
		const file = filePath();
		if (existsSync(file) && safeStorage.isEncryptionAvailable()) {
			const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file)));
			// Version 1 held answers per module category, none for a file as a whole: every file is asked once
			if (parsed?.version === 2 && typeof parsed.natives === "object" && parsed.natives !== null) return (store = parsed as PermissionStore);
		}
	} catch (err) {
		console.error("[🛑Security🛑] Failed to load native permissions, starting fresh.", err);
	}
	return (store = { version: 2, natives: {} });
};

export const saveStore = () => {
	try {
		if (store === undefined || !safeStorage.isEncryptionAvailable()) return;
		// Sync: answers can come back to back, and overlapping async writes to one file can corrupt it
		writeFileSync(filePath(), safeStorage.encryptString(JSON.stringify(store)));
	} catch (err) {
		console.error("[🛑Security🛑] Failed to save native permissions.", err);
	}
};
