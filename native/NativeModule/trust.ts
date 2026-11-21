import { BrowserWindow, dialog } from "electron";

import { ipcHandle } from "../ipc";
import { categoryInfo, categoryOf } from "./permissions/categories";
import { getStore, legacyAllowed, migrateLegacy, recordKey, saveStore, type NativeRecord, type PermissionAnswer } from "./permissions/store";
import { verifySource } from "./permissions/verifySource";
import { askPermissions } from "./permissions/window";

import type { NativeModuleInfo } from ".";

// The trust of every loaded native file, so a revoke takes effect at once. By plugin url and file name: a reload replaces it
const live = new Map<string, NativeTrust>();

/**
 * Permissions of one load of a native file. Node modules are asked for by category (see permissions/categories.ts),
 * all categories a file requires while it loads in one window.
 */
export class NativeTrust {
	/** Set once the url the renderer named was found to serve this code (see verifySource) */
	private verifiedUrl?: string;
	private verifying?: Promise<boolean>;
	// Decisions of this load, per category. Never key this by the function being called: e.g. require("os").hostname is the same object for every plugin.
	private readonly decided = new Map<string, boolean>();
	private readonly legacy = new Set<string>();
	// Modules the code required or called, per category
	private readonly modules = new Map<string, Set<string>>();
	/** While true (the code runs under the vm timeout, see secureLoad) a call that needs an answer throws instead of asking */
	public loading = false;

	constructor(
		private readonly info: NativeModuleInfo,
		private readonly parent?: BrowserWindow,
	) {}

	/** Called once the code has loaded, replacing the trust of an earlier load of the same file */
	public activate() {
		live.set(`${this.info.url}::${this.info.fileName}`, this);
	}

	private get fileName() {
		return this.info.fileName;
	}

	/** Called when the code requires a module, so the window can ask for it before it is used */
	public seen(moduleName: string) {
		const category = categoryOf(moduleName);
		let modules = this.modules.get(category);
		if (modules === undefined) this.modules.set(category, (modules = new Set()));
		modules.add(moduleName);
	}

	private saved(category: string): boolean | undefined {
		const { fileName, hash, url } = this.info;
		const { natives } = getStore();
		const claimed = url === undefined ? undefined : natives[recordKey(fileName, hash, url)];
		const ownBuild = natives[recordKey(fileName, hash)];
		// Denials hold for the url the renderer named even if it could not be checked: they only take access away
		if (claimed?.categories[category]?.answer === "deny" || ownBuild?.categories[category]?.answer === "deny") return false;

		// Allowed for updates: any build the url serves
		const forUpdates = claimed?.categories[category];
		if (this.verifiedUrl !== undefined && forUpdates?.answer === "allowUpdates") {
			if (!forUpdates.hashes.includes(hash)) {
				// Remembered for this build, so it also holds when the url can't be checked (offline)
				forUpdates.hashes = [hash];
				saveStore();
			}
			return true;
		}

		// An allow for this exact code holds whoever registers it
		for (const record of Object.values(natives)) {
			if (record.fileName !== fileName) continue;
			const decision = record.categories[category];
			if (decision !== undefined && decision.answer !== "deny" && decision.hashes.includes(hash)) return true;
		}
		return undefined;
	}

	private decide(moduleName: string): boolean | undefined {
		const category = categoryOf(moduleName);
		const decided = this.decided.get(category);
		if (decided !== undefined) return decided;
		const saved = this.saved(category);
		if (saved !== undefined) {
			this.decided.set(category, saved);
			return saved;
		}
		// Answers from before categories, per module
		if (this.legacy.has(moduleName)) return true;
		if (legacyAllowed(this.info.hash, moduleName)) {
			this.legacy.add(moduleName);
			return true;
		}
		return undefined;
	}

	/** Whether the code may use `moduleName`. Asks right away if it is not decided yet, unless the code is loading */
	public check(moduleName: string): boolean {
		const decision = this.decide(moduleName);
		if (decision !== undefined) return decision;
		this.seen(moduleName);
		if (this.loading) throw new Error(`[🛑Security🛑] '${moduleName}' in '${this.fileName}' needs permission, asking after load`);
		return this.askNow(moduleName);
	}

	/** Categories the code required that have no answer yet */
	public pending(): { category: string; modules: string[] }[] {
		const pending = [];
		for (const [category, modules] of this.modules) {
			if ([...modules].some((moduleName) => this.decide(moduleName) === undefined)) pending.push({ category, modules: [...modules] });
		}
		return pending;
	}

	private verify(): Promise<boolean> {
		const { url, fileName, hash } = this.info;
		if (url === undefined) return Promise.resolve(false);
		return (this.verifying ??= verifySource(url, fileName, hash).then((ok) => {
			if (ok) this.verifiedUrl = url;
			return ok;
		}));
	}

	private save(rows: { category: string; modules: string[] }[], answers: PermissionAnswer[]) {
		const { fileName, hash, url: claimedUrl } = this.info;
		const url = this.verifiedUrl;
		const { natives } = getStore();
		const record = (natives[recordKey(fileName, hash, url)] ??= { url, claimedUrl, fileName, categories: {} });
		rows.forEach(({ category, modules }, i) => {
			const answer = answers[i];
			record.categories[category] = { answer, hashes: [hash], modules, at: Date.now() };
			this.decided.set(category, answer !== "deny");
			migrateLegacy(hash, modules);
		});
		saveStore();
	}

	/** Moves categories that only old per-module answers allow into the new store, so they show in settings and can be revoked */
	public adoptLegacy() {
		const rows = [];
		for (const [category, modules] of this.modules) {
			if (this.saved(category) !== undefined) continue;
			if ([...modules].every((moduleName) => legacyAllowed(this.info.hash, moduleName))) rows.push({ category, modules: [...modules] });
		}
		if (rows.length > 0) this.save(rows, Array(rows.length).fill("allow"));
	}

	/** Asks for every pending category in one window */
	public async ask(): Promise<void> {
		if (this.pending().length === 0) return;
		await this.verify();
		// Answers for updates count once the url is checked
		const rows = this.pending();
		if (rows.length === 0) return;

		const { fileName, hash, url } = this.info;
		const claimed = getStore().natives[recordKey(fileName, hash, this.verifiedUrl)];
		const kept = Object.entries(claimed?.categories ?? {})
			.filter(([category]) => !rows.some((row) => row.category === category))
			.map(([category, { answer }]) => ({ category, answer }));

		const answers = await askPermissions({ fileName, url: this.verifiedUrl, claimedUrl: url, rows, kept }, this.parent);
		if (answers === undefined) {
			// Closed: denied for now, asked again next time
			for (const { category } of rows) this.decided.set(category, false);
			console.warn(`[🛑Security🛑] Permission window for '${fileName}' closed without an answer, denied until it loads again`);
			return;
		}
		this.save(rows, answers);
	}

	/** A module first used after the load: no window can be awaited here, so ask with a message box */
	private askNow(moduleName: string): boolean {
		const category = categoryOf(moduleName);
		const { label, description } = categoryInfo(category);
		const answers: PermissionAnswer[] = ["deny", "allow"];
		const buttons = ["Deny", "Allow"];
		if (this.verifiedUrl !== undefined) {
			answers.push("allowUpdates");
			buttons.push("Allow, also for updates");
		}
		const win = BrowserWindow.getFocusedWindow() ?? this.parent;
		const options: Electron.MessageBoxSyncOptions = {
			type: "warning",
			buttons,
			defaultId: 0,
			cancelId: 0,
			title: "Plugin Permission Request",
			message: `Allow '${this.fileName}' ${label}?`,
			detail: `${description}
Module: ${moduleName}
Source: ${this.verifiedUrl ?? this.info.url ?? "unknown"}
If allowed, this may grant FULL SYSTEM ACCESS (Files, Network, Processes, etc).
Only click "Allow" if you trust this!`,
			noLink: true,
			normalizeAccessKeys: true,
		};
		const response = win !== undefined && !win.isDestroyed() ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
		const answer = answers[response] ?? "deny";
		this.save([{ category, modules: [...(this.modules.get(category) ?? [moduleName])] }], [answer]);
		return answer !== "deny";
	}

	/** Forget this load's decisions, so a revoked answer is asked for again on the next use */
	public reset() {
		this.decided.clear();
		this.legacy.clear();
	}
}

/**
 * Runs `load` without asking: a call that needs an answer throws instead (the vm timeout counts the time a prompt
 * is open, and the answer would be lost). Once `load` has stopped, every category it required is asked in one
 * window, and `load` runs again if it failed, until it needs no new answers.
 */
export const loadWithPermissions = async <T>(trust: NativeTrust, load: () => T): Promise<T> => {
	while (true) {
		let exports: T | undefined;
		let error: unknown;
		let failed = false;
		trust.loading = true;
		try {
			exports = load();
		} catch (err) {
			failed = true;
			error = err;
		} finally {
			trust.loading = false;
		}
		if (trust.pending().length === 0) {
			if (failed) throw error;
			trust.adoptLegacy();
			trust.activate();
			return exports!;
		}
		await trust.ask();
		if (!failed) {
			trust.adoptLegacy();
			trust.activate();
			return exports!;
		}
	}
};

// #region Settings
export type NativePermissionEntry = {
	key: string;
	fileName: string;
	url?: string;
	claimedUrl?: string;
	categories: { category: string; label: string; answer: PermissionAnswer; modules: string[]; at: number }[];
};

ipcHandle("__Luna.nativePermissions.list", (): NativePermissionEntry[] =>
	Object.entries(getStore().natives).map(([key, { fileName, url, claimedUrl, categories }]) => ({
		key,
		fileName,
		url,
		claimedUrl,
		categories: Object.entries(categories).map(([category, { answer, modules, at }]) => ({
			category,
			label: categoryInfo(category).label,
			answer,
			modules,
			at,
		})),
	})),
);

const resetLive = () => {
	for (const trust of live.values()) trust.reset();
};

// Revoking only ever takes answers away, so the renderer may ask for it. The next use asks again
ipcHandle("__Luna.nativePermissions.revoke", (_, key: string, category?: string) => {
	const { natives } = getStore();
	const record: NativeRecord | undefined = natives[key];
	if (record === undefined) return;
	if (category === undefined) delete natives[key];
	else {
		delete record.categories[category];
		if (Object.keys(record.categories).length === 0) delete natives[key];
	}
	saveStore();
	resetLive();
});

// Uninstalling a plugin forgets its answers, so a reinstall asks again
ipcHandle("__Luna.nativePermissions.forget", (_, url: string) => {
	const { natives } = getStore();
	let changed = false;
	for (const [key, record] of Object.entries(natives)) {
		if (record.url !== url && record.claimedUrl !== url) continue;
		delete natives[key];
		changed = true;
	}
	if (!changed) return;
	saveStore();
	resetLive();
});
// #endregion
