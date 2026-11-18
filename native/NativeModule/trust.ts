import { app, BrowserWindow, dialog, safeStorage } from "electron";
import { moduleAlias } from "./moduleAlias";

import type { NativeModuleInfo } from ".";

import { existsSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import path from "path";

let trustStore: Map<string, boolean>;
const getTrustStore = () => {
	if (trustStore !== undefined) return trustStore;
	try {
		const STORE_PATH = path.join(app.getPath("userData"), "luna-trust-store.enc");
		if (existsSync(STORE_PATH) && safeStorage.isEncryptionAvailable()) {
			const encryptedBuffer = readFileSync(STORE_PATH);
			const decryptedString = safeStorage.decryptString(encryptedBuffer);
			// Rehydrate Map from JSON array of entries
			trustStore = new Map(JSON.parse(decryptedString));
		} else {
			trustStore = new Map();
		}
	} catch (e) {
		console.error("[🛑Security🛑] Failed to load trust store, starting fresh.", e);
		trustStore = new Map();
	}
};

// Helper: Save the Trust Store to Disk
const saveErr = "[🛑Security🛑] Failed to save trust store.";
const saveTrustStore = () => {
	try {
		if (!trustStore || !safeStorage.isEncryptionAvailable()) return;
		// Serialize Map to JSON entries
		const jsonString = JSON.stringify(Array.from(trustStore.entries()));
		const encryptedBuffer = safeStorage.encryptString(jsonString);
		const STORE_PATH = path.join(app.getPath("userData"), "luna-trust-store.enc");
		writeFile(STORE_PATH, encryptedBuffer).catch((e) => {
			console.error(saveErr, e);
		});
	} catch (e) {
		console.error(saveErr, e);
	}
};

// Decisions made this session, per plugin code hash and module name.
// Never key this by the function being called: e.g. require("os").hostname is the same object for every plugin.
const fastCache = new Map<string, Map<string, boolean>>();
const setFastCache = (hash: string, moduleName: string, decision: boolean) => {
	let decisions = fastCache.get(hash);
	if (decisions === undefined) fastCache.set(hash, (decisions = new Map()));
	decisions.set(moduleName, decision);
};

export const isTrusted = ({ hash, fileName }: NativeModuleInfo, moduleName: string): boolean => {
	// If this plugin was already allowed/blocked for this module, return immediately. Cost: two O(1) lookups. Zero garbage generation.
	const cached = fastCache.get(hash)?.get(moduleName);
	if (cached !== undefined) return cached;

	getTrustStore();
	const methodHash = `${hash}::${moduleName}`;

	if (trustStore.has(methodHash)) {
		const decision = trustStore.get(methodHash)!;
		// re-prompt on saved denies
		if (decision === true) {
			// Backfill fastCache so next time we skip the string build/map lookup
			setFastCache(hash, moduleName, decision);
			return decision;
		}
	}

	const win = BrowserWindow.getFocusedWindow();
	const responseIndex = dialog.showMessageBoxSync(win!, {
		type: "warning",
		buttons: ["BLOCK Execution", "Allow System Access"],
		defaultId: 0,
		cancelId: 0,
		title: "Security Warning",
		message: `Allow plugin access to ${moduleAlias(moduleName)}?`,
		detail: `Plugin: '${fileName}'
Module: ${moduleName}
If allowed, this may grant FULL SYSTEM ACCESS (Files, Network, Processes, etc).
Only click "Allow" if you trust this!`,
		noLink: true,
		normalizeAccessKeys: true,
	});
	const isAllowed = responseIndex === 1;

	trustStore.set(methodHash, isAllowed); // Save to Map
	setFastCache(hash, moduleName, isAllowed); // Save to session cache
	saveTrustStore(); // Write to Disk

	return isAllowed;
};
