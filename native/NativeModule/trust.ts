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

const fastCache = new WeakMap<object, boolean>();

// Prompts needed while module code runs under the vm timeout (see secureLoad), to be asked once it has stopped
let deferredPrompts: Map<string, () => boolean> | undefined;

/**
 * Runs `load` without showing trust prompts: a call that would prompt throws instead and its prompt is returned in `prompts`.
 * Calling a returned prompt shows the dialog and saves the answer.
 */
export const withDeferredPrompts = <T>(load: () => T) => {
	const prompts = (deferredPrompts = new Map<string, () => boolean>());
	try {
		return { exports: load(), prompts: [...prompts.values()] };
	} catch (error) {
		return { error, prompts: [...prompts.values()] };
	} finally {
		deferredPrompts = undefined;
	}
};

export const isTrusted = (moduleInfo: NativeModuleInfo, moduleName: string, module: object): boolean => {
	const { hash, fileName } = moduleInfo;
	// If we have already verified this exact object, return immediately. Cost: O(1) lookup. Zero garbage generation.
	if (fastCache.has(module)) return fastCache.get(module)!;

	getTrustStore();
	const methodHash = `${hash}::${moduleName}`;

	if (trustStore.has(methodHash)) {
		const decision = trustStore.get(methodHash)!;
		// re-prompt on saved denies
		if (decision === true) {
			// Backfill fastCache so next time we skip the string build/map lookup
			fastCache.set(module, decision);
			return decision;
		}
	}

	if (deferredPrompts !== undefined) {
		deferredPrompts.set(methodHash, () => isTrusted(moduleInfo, moduleName, module));
		throw new Error(`[🛑Security🛑] '${moduleName}' in '${fileName}' needs permission, asking after load`);
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
	fastCache.set(module, isAllowed); // Save to WeakMap
	saveTrustStore(); // Write to Disk

	return isAllowed;
};
