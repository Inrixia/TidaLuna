import { BrowserWindow, dialog } from "electron";

import { ipcHandle } from "../ipc";
import { categoryInfo, categoryOf } from "./permissions/categories";
import {
	getStore,
	legacyAllowed,
	migrateLegacy,
	recordKey,
	retireLegacy,
	saveStore,
	type NativeRecord,
	type PermissionAnswer,
} from "./permissions/store";
import { verifySource } from "./permissions/verifySource";
import { ALL_VERSIONS_WARNING, askPermissions } from "./permissions/window";

import type { NativeModuleInfo } from ".";

// The trust of every load of a native file, so a revoke takes effect at once. Every load: code of an earlier load
// (or of another plugin naming the same url) can still be running
const live = new Set<WeakRef<NativeTrust>>();

// The file whose code runs under the vm timeout right now (vm runs are synchronous, so one at a time). Its code can
// call into other loaded files (e.g. luna.lib.native): their calls that need an answer are asked after its run too
let running: NativeTrust | undefined;
const waiting = new Set<NativeTrust>();

/**
 * An entry is about to be replaced by one for `hash`: the other builds it named drop out of the record, so revoke and
 * uninstall could no longer retire their old answers. Retire them now (those builds are asked again if they ever load)
 */
const retireReplaced = (existing: NativeRecord["categories"][string] | undefined, hash: string) => {
	const others = existing?.hashes.filter((other) => other !== hash) ?? [];
	if (others.length > 0) retireLegacy(new Set(others));
};

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
	/**
	 * Set when a call threw because it needed an answer, while loading or while the window was open (the code's timers
	 * and promises still run then). The code may have caught it, so it is loaded again once answered
	 */
	public deferred = false;
	/** From the first run until the code is activated: timers and promises of a run can call in between */
	public settling = false;
	private asking = false;
	private inFlight?: Promise<void>;
	private active = false;

	constructor(
		private readonly info: NativeModuleInfo,
		private readonly parent?: BrowserWindow,
	) {
		// Also while it loads: a revoke must drop answers it already took
		live.add(new WeakRef(this));
	}

	/** Called once the code has loaded */
	public activate() {
		if (this.active) return;
		this.active = true;
		this.settling = false;
		// So a module first used later can be allowed for updates (see askNow), and old answers move to the plugin url's entry
		void this.verify().finally(() => this.adoptLegacy());
	}

	public get fileName() {
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
				forUpdates.hashes.push(hash);
				saveStore();
			}
			return true;
		}

		// An allow for this exact code holds whoever registers it
		for (const record of Object.values(natives)) {
			if (record.fileName !== fileName) continue;
			const decision = record.categories[category];
			if (decision === undefined || decision.onlyModules) continue;
			if (decision.answer !== "deny" && decision.hashes.includes(hash)) return true;
		}
		return undefined;
	}

	/** Old per-module answers moved into the store (see adoptLegacy): they allow their modules only */
	private adoptedAllows(moduleName: string): boolean {
		const { fileName, hash } = this.info;
		const category = categoryOf(moduleName);
		return Object.values(getStore().natives).some((record) => {
			const decision = record.fileName === fileName ? record.categories[category] : undefined;
			return (
				decision?.onlyModules === true && decision.answer !== "deny" && decision.hashes.includes(hash) && decision.modules.includes(moduleName)
			);
		});
	}

	/** Before the first run: an update allowed "also for updates" needs the url checked, or its run fails and is repeated */
	public async prepare() {
		const { fileName, hash, url } = this.info;
		if (url === undefined) return;
		const claimed = getStore().natives[recordKey(fileName, hash, url)];
		const forUpdates = Object.values(claimed?.categories ?? {}).some(({ answer, hashes }) => answer === "allowUpdates" && !hashes.includes(hash));
		if (forUpdates) await this.verify();
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
		// Answers from before categories, per module (none for code of a plugin uninstalled since it loaded)
		if (this.removed) return undefined;
		if (this.legacy.has(moduleName)) return true;
		if (this.adoptedAllows(moduleName)) {
			this.legacy.add(moduleName);
			return true;
		}
		if (legacyAllowed(this.info.hash, moduleName)) {
			this.legacy.add(moduleName);
			// Also modules only used after the load (or never required, like WebAssembly): moved into the store, so they can be revoked
			this.seen(moduleName);
			if (this.active) void this.verify().finally(() => this.adoptLegacy());
			return true;
		}
		return undefined;
	}

	/** Whether the code may use `moduleName`. Asks right away if it is not decided yet, unless the code is loading */
	public check(moduleName: string): boolean {
		const decision = this.decide(moduleName);
		if (decision !== undefined) return decision;
		if (!this.mayAsk) {
			console.warn(`[🛑Security🛑] '${moduleName}' in '${this.fileName}' denied: its plugin was uninstalled`);
			return false;
		}
		this.seen(moduleName);
		if (this.loading || this.settling || this.asking || running !== undefined) {
			if (this.loading || this.settling || this.asking) this.deferred = true;
			if (running !== undefined && running !== this) {
				// Called from another file's run: asked after it (or awaited, if its window is open), and that file is loaded again
				waiting.add(this);
				running.deferred = true;
			}
			throw new Error(`[🛑Security🛑] '${moduleName}' in '${this.fileName}' needs permission, asking after load`);
		}
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
			// A failed check (e.g. offline) is tried again next time
			else this.verifying = undefined;
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
			retireReplaced(record.categories[category], hash);
			record.categories[category] = { answer, hashes: [hash], modules, at: Date.now() };
			this.decided.set(category, answer !== "deny");
			// Old answers for every module of the category, also those the code did not use, must not outlive it
			retireLegacy(new Set([hash]), category);
		});
		saveStore();
	}

	/**
	 * Moves old per-module answers of the modules the code used into the new store, so they show in settings and can be
	 * revoked. They keep allowing those modules only: an old "your SYSTEM" answer for v8 must not allow all of Debugging
	 */
	public adoptLegacy() {
		const { fileName, hash, url: claimedUrl } = this.info;
		// Nothing is kept for a plugin uninstalled since it loaded
		if (this.removed) return;
		let changed = false;
		for (const [category, modules] of this.modules) {
			if (this.saved(category) !== undefined) continue;
			const adopted = [...modules].filter((moduleName) => legacyAllowed(hash, moduleName));
			if (adopted.length === 0) continue;
			const url = this.verifiedUrl;
			const record = (getStore().natives[recordKey(fileName, hash, url)] ??= { url, claimedUrl, fileName, categories: {} });
			const existing = record.categories[category];
			// One build per entry: old answers were given per build and module, so another build's modules must not add up
			if (existing === undefined || (existing.onlyModules && !existing.hashes.includes(hash))) {
				retireReplaced(existing, hash);
				record.categories[category] = { answer: "allow", hashes: [hash], modules: adopted, onlyModules: true, at: Date.now() };
			} else if (existing.onlyModules) existing.modules = [...new Set([...existing.modules, ...adopted])];
			else continue;
			migrateLegacy(hash, adopted);
			changed = true;
		}
		if (changed) saveStore();
	}

	/** Asks for every pending category in one window. While one is open, waits for it */
	public ask(): Promise<void> {
		return (this.inFlight ??= this.askOnce().finally(() => (this.inFlight = undefined)));
	}

	private async askOnce(): Promise<void> {
		if (this.pending().length === 0) return;
		this.asking = true;
		try {
			// Again if calls made while it was open need more (every row is decided once a window has answered or closed)
			while (this.pending().length > 0) await this.askWindow();
		} finally {
			this.asking = false;
		}
	}

	private async askWindow(): Promise<void> {
		await this.verify();
		// Answers for updates count once the url is checked
		const rows = this.pending();
		if (rows.length === 0) return;
		if (this.denyIfRemoved(rows)) return;

		const { fileName, hash, url } = this.info;
		const claimed = getStore().natives[recordKey(fileName, hash, this.verifiedUrl)];
		const kept = Object.entries(claimed?.categories ?? {})
			.filter(([category]) => !rows.some((row) => row.category === category))
			// Only answers that hold for this build as a whole: an "allow" of another build, or an old answer for some modules, does not
			.filter(([, { answer, hashes, onlyModules }]) => !onlyModules && (answer !== "allow" || hashes.includes(hash)))
			.map(([category, { answer }]) => ({ category, answer }));

		const answers = await askPermissions({ fileName, url: this.verifiedUrl, claimedUrl: url, rows, kept }, this.parent);
		// Uninstalled while the window was open: its answers must not outlive the uninstall
		if (this.denyIfRemoved(rows)) return;
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
		// "Not now" (also Esc or closing) saves nothing: denied for this load, asked again next time
		const answers: (PermissionAnswer | undefined)[] = [undefined, "deny", "allow"];
		const buttons = ["Not now", "Deny", "This version"];
		if (this.verifiedUrl !== undefined) {
			answers.push("allowUpdates");
			buttons.push("All versions...");
		}
		// Not owned by a hidden or minimized window: the box would be hidden with it while it blocks the main process
		const win = [BrowserWindow.getFocusedWindow(), this.parent].find((w) => w != null && !w.isDestroyed() && w.isVisible() && !w.isMinimized());
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
Only allow it if you trust this plugin!`,
			noLink: true,
			normalizeAccessKeys: true,
		};
		const show = (options: Electron.MessageBoxSyncOptions) =>
			win != null ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options);
		let answer = answers[show(options)];
		// Allowing all versions must be confirmed: later code from this source gets it without asking
		if (answer === "allowUpdates") {
			const confirmed = show({
				type: "warning",
				buttons: ["Cancel", "Allow all versions"],
				defaultId: 0,
				cancelId: 0,
				title: "Allow all versions?",
				message: `Allow ${label} for all versions of '${this.fileName}'?`,
				detail: `${ALL_VERSIONS_WARNING}\nSource: ${this.verifiedUrl}`,
				noLink: true,
			});
			if (confirmed !== 1) answer = undefined;
		}
		if (answer === undefined) {
			this.decided.set(category, false);
			return false;
		}
		this.save([{ category, modules: [...(this.modules.get(category) ?? [moduleName])] }], [answer]);
		return answer !== "deny";
	}

	/** Forget this load's decisions, so a revoked answer is asked for again on the next use */
	public reset() {
		this.decided.clear();
		this.legacy.clear();
	}

	/**
	 * Its plugin was uninstalled: its code may still run (timers, sockets), but nothing is asked for it any more. What it
	 * needs is denied, a reinstall loads it anew and asks
	 */
	public uninstalled(url: string): boolean {
		if (this.info.url !== url) return false;
		this.removed = true;
		this.reset();
		// Old answers of this build not moved into the store yet (it was still loading) must not outlive the uninstall either
		retireLegacy(new Set([this.info.hash]));
		return true;
	}
	private removed = false;
	/** Whether it may ask: not for code of a plugin uninstalled since it loaded */
	public get mayAsk() {
		return !this.removed;
	}
	/** Denies these rows for this load, saving nothing, if its plugin was uninstalled */
	private denyIfRemoved(rows: { category: string }[]): boolean {
		if (!this.removed) return false;
		for (const { category } of rows) this.decided.set(category, false);
		return true;
	}
}

const MAX_RUNS = 10;

/**
 * Runs `load` without asking: a call that needs an answer throws instead (the vm timeout counts the time a prompt
 * is open, and the answer would be lost). Once `load` has stopped, every category it required is asked in one
 * window, and `load` runs again if it failed or a call was refused (the code may have caught it), until it needs no
 * new answers.
 */
export const loadWithPermissions = async <T>(trust: NativeTrust, load: () => T): Promise<T> => {
	// Calls between runs and activation wait for answers too (see check)
	trust.settling = true;
	try {
		await trust.prepare();
		for (let run = 1; ; run++) {
			// Code that keeps needing new answers (e.g. a new module name every run) is not loaded forever
			if (run > MAX_RUNS) throw new Error(`[🛑Security🛑] '${trust.fileName}' still needs new permissions after ${MAX_RUNS} loads`);
			const exports = await runOnce(trust, load);
			// Uninstalled while it loaded: no exports, so a reinstall loads it anew (and asks) instead of reusing this load
			if (!trust.mayAsk) throw new Error(`[🛑Security🛑] '${trust.fileName}' was uninstalled while it loaded`);
			if (exports !== retry) return exports;
		}
	} finally {
		trust.settling = false;
	}
};

const retry = Symbol("retry");
const runOnce = async <T>(trust: NativeTrust, load: () => T): Promise<T | typeof retry> => {
	let exports: T | undefined;
	let error: unknown;
	let failed = false;
	trust.loading = true;
	trust.deferred = false;
	running = trust;
	try {
		exports = load();
	} catch (err) {
		failed = true;
		error = err;
	} finally {
		trust.loading = false;
		running = undefined;
	}
	const others = [...waiting];
	waiting.clear();
	for (const other of others) await other.ask();
	if (trust.pending().length === 0 && !trust.deferred) {
		if (failed) throw error;
		trust.activate();
		return exports!;
	}
	await trust.ask();
	// A call that needed an answer threw, even if the code caught it
	if (!failed && !trust.deferred) {
		trust.activate();
		return exports!;
	}
	return retry;
};

// #region Settings
export type NativePermissionEntry = {
	key: string;
	fileName: string;
	url?: string;
	claimedUrl?: string;
	categories: { category: string; label: string; answer: PermissionAnswer; modules: string[]; onlyModules: boolean; at: number }[];
};

ipcHandle("__Luna.nativePermissions.list", (): NativePermissionEntry[] =>
	Object.entries(getStore().natives).map(([key, { fileName, url, claimedUrl, categories }]) => ({
		key,
		fileName,
		url,
		claimedUrl,
		categories: Object.entries(categories).map(([category, { answer, modules, onlyModules, at }]) => ({
			category,
			label: categoryInfo(category).label,
			answer,
			modules,
			onlyModules: onlyModules === true,
			at,
		})),
	})),
);

const resetLive = () => {
	for (const ref of live) {
		const trust = ref.deref();
		if (trust === undefined) live.delete(ref);
		else trust.reset();
	}
};

// Revoking never grants anything, so the renderer may ask for it: the next use asks again. (A revoked denial is asked
// again too; any plugin can already open permission windows with native code of its own.)
const removeCategory = (key: string, record: NativeRecord, category: string) => {
	const answer = record.categories[category];
	if (answer === undefined) return;
	// Old per-module answers for the same code would allow it again
	retireLegacy(new Set(answer.hashes), category);
	delete record.categories[category];
	if (Object.keys(record.categories).length === 0) delete getStore().natives[key];
};
const hashesOf = (record: NativeRecord) => new Set(Object.values(record.categories).flatMap(({ hashes }) => hashes));

ipcHandle("__Luna.nativePermissions.revoke", (_, key: string, category?: string) => {
	const { natives } = getStore();
	const record: NativeRecord | undefined = natives[key];
	if (record === undefined) return;
	// Answers of other entries for the same code (e.g. given while its url could not be checked) would still allow it
	const hashes = hashesOf(record);
	for (const [otherKey, other] of Object.entries(natives)) {
		if (otherKey !== key && (other.fileName !== record.fileName || ![...hashesOf(other)].some((hash) => hashes.has(hash)))) continue;
		for (const name of category === undefined ? Object.keys(other.categories) : [category]) removeCategory(otherKey, other, name);
	}
	// Also old answers for modules the code has not used yet
	if (category === undefined) retireLegacy(hashes);
	saveStore();
	resetLive();
});

// Uninstalling a plugin forgets its answers, so a reinstall asks again
ipcHandle("__Luna.nativePermissions.forget", (_, url: string) => {
	const { natives } = getStore();
	let changed = false;
	for (const [key, record] of Object.entries(natives)) {
		if (record.url !== url && record.claimedUrl !== url) continue;
		retireLegacy(hashesOf(record));
		for (const category of Object.keys(record.categories)) removeCategory(key, record, category);
		changed = true;
	}
	resetLive();
	// Code of the uninstalled plugin that still runs must not ask again
	for (const ref of live) if (ref.deref()?.uninstalled(url)) changed = true;
	if (changed) saveStore();
});
// #endregion
