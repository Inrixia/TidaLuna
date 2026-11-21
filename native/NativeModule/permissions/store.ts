import { app, safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

/**
 * - allow: this build of the file only (its code hash)
 * - allowUpdates: any build the plugin's url serves, until the plugin is reinstalled or this is revoked
 * - deny: until the plugin is reinstalled or this is revoked
 */
export type PermissionAnswer = "deny" | "allow" | "allowUpdates";

export type CategoryRecord = {
	answer: PermissionAnswer;
	/** Code hashes this answer was given or checked for. An allow holds for these only */
	hashes: string[];
	/** Modules the code asked for in this category */
	modules: string[];
	at: number;
};

export type NativeRecord = {
	/** The plugin url, checked against what it serves (see verifySource.ts). Undefined when it could not be checked */
	url?: string;
	/** The url the renderer named for the plugin */
	claimedUrl?: string;
	fileName: string;
	categories: Record<string, CategoryRecord>;
};

type PermissionStore = {
	version: 1;
	natives: Record<string, NativeRecord>;
	/** Old trust store keys already moved into natives: they no longer count, so revoking the new record works */
	legacyMigrated: string[];
};

/**
 * A file of a plugin url, or one build of it when the url is unknown or could not be checked.
 * So a plugin of the same name from another store never shares answers with it.
 */
export const recordKey = (fileName: string, hash: string, url?: string) => (url !== undefined ? `${url}::${fileName}` : `${fileName}@${hash}`);

const filePath = (name: string) => path.join(app.getPath("userData"), name);
const readEncrypted = (name: string): string | undefined => {
	const file = filePath(name);
	if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return undefined;
	return safeStorage.decryptString(readFileSync(file));
};

// Answers saved before permissions had categories: `${hash}::${moduleName}` -> true. Read only, so a Luna downgrade still finds them
let legacy: Map<string, boolean> | undefined;
export const legacyAllowed = (hash: string, moduleName: string): boolean => {
	if (legacy === undefined) {
		try {
			const json = readEncrypted("luna-trust-store.enc");
			legacy = new Map(json === undefined ? [] : JSON.parse(json));
		} catch (err) {
			console.error("[🛑Security🛑] Failed to read the old trust store.", err);
			legacy = new Map();
		}
	}
	const key = `${hash}::${moduleName}`;
	return legacy.get(key) === true && !getStore().legacyMigrated.includes(key);
};
/** Called once an answer for these modules is in the new store */
export const migrateLegacy = (hash: string, modules: string[]) => {
	const { legacyMigrated } = getStore();
	for (const moduleName of modules) {
		const key = `${hash}::${moduleName}`;
		if (legacy?.get(key) === true && !legacyMigrated.includes(key)) legacyMigrated.push(key);
	}
};

const STORE_FILE = "luna-native-permissions.enc";
let store: PermissionStore | undefined;
export const getStore = (): PermissionStore => {
	if (store !== undefined) return store;
	try {
		const json = readEncrypted(STORE_FILE);
		if (json !== undefined) {
			const parsed = JSON.parse(json);
			if (parsed?.version === 1 && typeof parsed.natives === "object") {
				parsed.legacyMigrated ??= [];
				return (store = parsed as PermissionStore);
			}
		}
	} catch (err) {
		console.error("[🛑Security🛑] Failed to load native permissions, starting fresh.", err);
	}
	return (store = { version: 1, natives: {}, legacyMigrated: [] });
};

export const saveStore = () => {
	try {
		if (store === undefined || !safeStorage.isEncryptionAvailable()) return;
		// Sync: answers can come back to back, and overlapping async writes to one file can corrupt it
		writeFileSync(filePath(STORE_FILE), safeStorage.encryptString(JSON.stringify(store)));
	} catch (err) {
		console.error("[🛑Security🛑] Failed to save native permissions.", err);
	}
};
