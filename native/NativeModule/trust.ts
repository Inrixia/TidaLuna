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

// Set while module code runs under the vm timeout (see secureLoad): prompts are collected and asked once it has stopped
let deferred: { pending: Map<string, () => void>; answered: Map<string, boolean> } | undefined;

/**
 * Runs `load` without showing trust prompts: a call that would prompt throws instead. Once `load` has stopped, the
 * collected prompts are asked and `load` runs again, until it needs no new prompts. Answers are final for this call.
 */
export const loadWithDeferredPrompts = <T>(load: () => T): T => {
	const answered = new Map<string, boolean>();
	while (true) {
		const pending = new Map<string, () => void>();
		deferred = { pending, answered };
		let exports: T | undefined;
		let error: unknown;
		let failed = false;
		try {
			exports = load();
		} catch (err) {
			failed = true;
			error = err;
		} finally {
			deferred = undefined;
		}
		if (pending.size === 0) {
			if (failed) throw error;
			return exports!;
		}
		for (const prompt of pending.values()) prompt();
	}
};

export const isTrusted = (moduleInfo: NativeModuleInfo, moduleName: string, module: object): boolean => {
	const { hash, fileName } = moduleInfo;
	// If we have already verified this exact object, return immediately. Cost: O(1) lookup. Zero garbage generation.
	if (fastCache.has(module)) return fastCache.get(module)!;

	getTrustStore();
	const methodHash = `${hash}::${moduleName}`;

	// Already answered during this load (a saved deny would otherwise prompt again on every retry)
	if (deferred?.answered.has(methodHash)) return deferred.answered.get(methodHash)!;

	if (trustStore.has(methodHash)) {
		const decision = trustStore.get(methodHash)!;
		// re-prompt on saved denies
		if (decision === true) {
			// Backfill fastCache so next time we skip the string build/map lookup
			fastCache.set(module, decision);
			return decision;
		}
	}

	if (deferred !== undefined) {
		const { answered } = deferred;
		deferred.pending.set(methodHash, () => answered.set(methodHash, isTrusted(moduleInfo, moduleName, module)));
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
