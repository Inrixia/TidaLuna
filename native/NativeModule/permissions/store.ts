import { app, safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import { categoryOf } from "./categories";

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
	/** Moved from the old per-module store: allows only `modules`, not the whole category */
	onlyModules?: true;
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
 * A file of a plugin url, or one build of it when the url could not be checked (of the url the renderer named, if
 * any). Answers belong to one plugin: a plugin of the same name from another store, or another plugin with the same
 * code, never shares them.
 */
export const recordKey = (fileName: string, hash: string, url?: string, claimedUrl?: string) =>
	url !== undefined ? `${url}::${fileName}` : claimedUrl !== undefined ? `${claimedUrl}::${fileName}@${hash}` : `${fileName}@${hash}`;

/**
 * Builds whose url could not be checked were kept at `${fileName}@${hash}` whatever url was named, so every plugin with
 * that code read them. Each moves to the key of the url it was answered for (per category, the later answer wins)
 */
const keyByClaimedUrl = (natives: Record<string, NativeRecord>) => {
	for (const [key, record] of Object.entries(natives)) {
		const { url, claimedUrl, fileName } = record;
		if (url !== undefined || claimedUrl === undefined || !key.startsWith(`${fileName}@`)) continue;
		const moved = recordKey(fileName, key.slice(fileName.length + 1), undefined, claimedUrl);
		const target = (natives[moved] ??= { claimedUrl, fileName, categories: {} });
		for (const [category, answer] of Object.entries(record.categories)) {
			if ((target.categories[category]?.at ?? -Infinity) < answer.at) target.categories[category] = answer;
		}
		delete natives[key];
	}
};

const filePath = (name: string) => path.join(app.getPath("userData"), name);
const readEncrypted = (name: string): string | undefined => {
	const file = filePath(name);
	if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return undefined;
	return safeStorage.decryptString(readFileSync(file));
};

// Answers saved before permissions had categories: `${hash}::${moduleName}` -> true. Read only, so a Luna downgrade still finds them
let legacy: Map<string, boolean> | undefined;
const getLegacy = (): Map<string, boolean> => {
	if (legacy !== undefined) return legacy;
	try {
		const json = readEncrypted("luna-trust-store.enc");
		return (legacy = new Map(json === undefined ? [] : JSON.parse(json)));
	} catch (err) {
		console.error("[🛑Security🛑] Failed to read the old trust store.", err);
		return (legacy = new Map());
	}
};
export const legacyAllowed = (hash: string, moduleName: string): boolean => {
	const key = `${hash}::${moduleName}`;
	return getLegacy().get(key) === true && !getStore().legacyMigrated.includes(key);
};
/**
 * Called once an answer for these modules is in the new store, or was revoked or forgotten: old answers for them no
 * longer count. Given every module of the category, also those this build did not use, so none stays allowed unseen
 */
export const migrateLegacy = (hash: string, modules: Iterable<string>) => {
	const { legacyMigrated } = getStore();
	for (const moduleName of modules) {
		const key = `${hash}::${moduleName}`;
		if (getLegacy().get(key) === true && !legacyMigrated.includes(key)) legacyMigrated.push(key);
	}
};
/** Old answers of these builds no longer count, for one category or all (revoke, uninstall) */
export const retireLegacy = (hashes: Set<string>, category?: string) => {
	const { legacyMigrated } = getStore();
	for (const [key, allowed] of getLegacy()) {
		const at = key.indexOf("::");
		if (!allowed || at === -1 || !hashes.has(key.slice(0, at)) || legacyMigrated.includes(key)) continue;
		if (category !== undefined && categoryOf(key.slice(at + 2)) !== category) continue;
		legacyMigrated.push(key);
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
				keyByClaimedUrl(parsed.natives);
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
