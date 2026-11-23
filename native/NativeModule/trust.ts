import { BrowserWindow } from "electron";

import { ipcHandle } from "../ipc";
import { getStore, recordKey, saveStore, type NativeRecord, type PermissionAnswer } from "./permissions/store";
import { verifySource } from "./permissions/verifySource";
import { askPermission } from "./permissions/window";

import type { NativeModuleInfo } from ".";

// The trust of every load of a native file, so a revoke takes effect at once. Every load: code of an earlier load
// (or of another plugin naming the same url) can still be running
const live = new Set<WeakRef<NativeTrust>>();

/** Every load reads its answer from the store again */
const resetLive = () => {
	for (const ref of live) {
		const trust = ref.deref();
		if (trust === undefined) live.delete(ref);
		else trust.reset();
	}
};

/**
 * Whether one load of a native file may run in TIDAL's main process. Asked once per file, before any of its code runs:
 * the sandbox it runs in limits what honest code uses, it can't hold code that works against it. So the answer is for
 * the file as a whole, and an allowed file is not asked for the Node modules it uses.
 */
export class NativeTrust {
	/** Set once the url the renderer named was found to serve this code (see verifySource) */
	private verifiedUrl?: string;
	/** The answer of this load. Unset: as saved */
	private decided?: boolean;
	// Modules the source names (see secureLoad): shown in the window and in settings, for information
	private readonly modules = new Set<string>();
	private abandoned = false;
	private removed = false;

	constructor(
		private readonly info: NativeModuleInfo,
		private readonly parent?: BrowserWindow,
	) {
		// Also while it loads: a revoke must drop the answer it already took
		live.add(new WeakRef(this));
	}

	public get fileName() {
		return this.info.fileName;
	}

	/** Called for a module the source names, before the code runs (see secureLoad) */
	public names(moduleName: string) {
		this.modules.add(moduleName);
	}

	/**
	 * Its load ended without exports (refused, failed). Code of it can still be running (timers, sockets, promises):
	 * from now on it is denied the modules it calls
	 */
	public abandon() {
		this.abandoned = true;
	}

	/**
	 * Read from its own plugin's entries only: the one of the url the renderer named and the one of its build (answered
	 * while that url could not be checked). Never another plugin's, even for the same code: each plugin is asked on its own
	 */
	private saved(): boolean | undefined {
		const { fileName, hash, url } = this.info;
		const { natives } = getStore();
		const claimed = url === undefined ? undefined : natives[recordKey(fileName, hash, url)];
		const ownBuild = natives[recordKey(fileName, hash, undefined, url)];
		// Denials hold for the url the renderer named even if it could not be checked: they only take access away
		if (claimed?.answer === "deny" || ownBuild?.answer === "deny") return false;

		// Allowed for updates: any build the url serves
		if (this.verifiedUrl !== undefined && claimed?.answer === "allowUpdates") return true;

		// This build allowed for its plugin (also one remembered for all versions, see rememberBuild, so it loads offline)
		return claimed?.hashes.includes(hash) || ownBuild?.hashes.includes(hash) ? true : undefined;
	}

	private decide(): boolean | undefined {
		if (this.abandoned || this.removed) return false;
		return (this.decided ??= this.saved());
	}

	/**
	 * Whether the code may run and use Node modules, as it stands now: the answer can be revoked while the code runs.
	 * Nothing is asked then, the next load asks
	 */
	public get allowed(): boolean {
		// Luna's own code, built together with this injector: still sandboxed, just never asked
		return this.info.isCore || this.decide() === true;
	}

	/** Asks, unless it is answered already, whether the code may run in the main process. Before any of it runs */
	public async mayRun(): Promise<boolean> {
		if (this.info.isCore) return true;
		if (this.decide() === undefined) {
			// An answer for all versions counts once the url is checked. Not checked for a build allowed as it is, so that loads offline
			await this.verify();
			if (this.decide() === undefined) await this.ask();
			// After the window too: one before it in the queue (another build of this file) may have answered for all versions
			this.rememberBuild();
		}
		return this.allowed;
	}

	/** A build that loads on an answer for all versions is added to it, so it also loads when the url can't be checked (offline) */
	private rememberBuild() {
		const { fileName, hash } = this.info;
		if (this.verifiedUrl === undefined) return;
		const record: NativeRecord | undefined = getStore().natives[recordKey(fileName, hash, this.verifiedUrl)];
		if (record?.answer !== "allowUpdates" || record.hashes.includes(hash)) return;
		record.hashes.push(hash);
		record.modules = [...this.modules];
		saveStore();
	}

	/** Why `mayRun` said no */
	public get refusal(): string {
		if (this.removed) return "was uninstalled while it loaded";
		const kept = this.saved() === false ? "the saved answer can be revoked in Luna Settings" : "it asks again the next time it loads";
		return `was not allowed to run in the main process (${kept})`;
	}

	private async verify(): Promise<void> {
		const { url, fileName, hash } = this.info;
		if (url !== undefined && (await verifySource(url, fileName, hash))) this.verifiedUrl = url;
	}

	private async ask(): Promise<void> {
		const { fileName, url: claimedUrl } = this.info;
		// Windows open one at a time, so whether to ask is looked at when this one's turn comes: a window before it may
		// have answered (another load of this file), or its plugin was uninstalled meanwhile
		const shown = await askPermission(
			() => (this.decide() !== undefined ? undefined : { fileName, url: this.verifiedUrl, claimedUrl, modules: [...this.modules] }),
			this.parent,
		);
		// Uninstalled while the window was open: its answer must not outlive the uninstall
		if (shown === undefined || this.removed) return;
		if (shown.answer === undefined) {
			// Closed: not run, asked again next time
			this.decided = false;
			console.warn(`[🛑Security🛑] Permission window for '${fileName}' closed without an answer, it is not loaded`);
			return;
		}
		this.save(shown.answer);
	}

	private save(answer: PermissionAnswer) {
		const { fileName, hash, url: claimedUrl } = this.info;
		const url = this.verifiedUrl;
		// Replaces an answer for an earlier build of the url: that build is asked again if it ever loads
		getStore().natives[recordKey(fileName, hash, url, claimedUrl)] = {
			url,
			claimedUrl,
			fileName,
			answer,
			hashes: [hash],
			modules: [...this.modules],
		};
		saveStore();
		// Another load of this file (e.g. a reload while this window was open) must not keep an older answer
		resetLive();
	}

	/** Forget this load's answer, so a revoked or replaced one no longer counts */
	public reset() {
		this.decided = undefined;
	}

	/**
	 * Its plugin was uninstalled: its code may still run (timers, sockets), but it is denied the modules it calls and
	 * nothing is asked for it any more. A reinstall loads it anew and asks
	 */
	public uninstalled(url: string) {
		if (this.info.url === url) this.removed = true;
	}
}

/**
 * Asks whether the code may run in the main process at all (see NativeTrust.mayRun), then runs `load`.
 * Nothing of a file the user has not accepted runs, and nothing else is asked once it is accepted.
 */
export const loadWithPermissions = async <T>(trust: NativeTrust, load: () => T): Promise<T> => {
	try {
		if (!(await trust.mayRun())) throw new Error(`[🛑Security🛑] '${trust.fileName}' ${trust.refusal}`);
		return load();
	} catch (err) {
		trust.abandon();
		throw err;
	}
};

// #region Settings
export type NativePermissionEntry = Pick<NativeRecord, "fileName" | "url" | "claimedUrl" | "answer" | "modules"> & { key: string };

ipcHandle("__Luna.nativePermissions.list", (): NativePermissionEntry[] =>
	Object.entries(getStore().natives).map(([key, { fileName, url, claimedUrl, answer, modules }]) => ({ key, fileName, url, claimedUrl, answer, modules })),
);

/** The plugin an entry is of: its url, checked or as named (none for code without a url) */
const pluginOf = (record: NativeRecord) => record.url ?? record.claimedUrl;

// Revoking never grants anything, so the renderer may ask for it: the file is asked again the next time it loads, and
// code of it that runs is denied Node modules until then. (A revoked denial is asked again too; any plugin can already
// open permission windows with native code of its own.)
ipcHandle("__Luna.nativePermissions.revoke", (_, key: string) => {
	const { natives } = getStore();
	const record: NativeRecord | undefined = natives[key];
	if (record === undefined) return;
	// Its plugin's other entries for the same code (given while the url could not be checked) would still allow it.
	// Not another plugin's: those are that plugin's own answers
	const plugin = pluginOf(record);
	for (const [otherKey, other] of Object.entries(natives)) {
		const sibling = other.fileName === record.fileName && pluginOf(other) === plugin && other.hashes.some((hash) => record.hashes.includes(hash));
		if (otherKey === key || sibling) delete natives[otherKey];
	}
	saveStore();
	resetLive();
});

// Uninstalling a plugin forgets its answers, so a reinstall asks again
ipcHandle("__Luna.nativePermissions.forget", (_, url: unknown) => {
	// Not undefined: that would match every entry without a url
	if (typeof url !== "string") return;
	const { natives } = getStore();
	let changed = false;
	for (const [key, record] of Object.entries(natives)) {
		if (record.url !== url && record.claimedUrl !== url) continue;
		delete natives[key];
		changed = true;
	}
	if (changed) saveStore();
	resetLive();
	// Code of the uninstalled plugin that still runs must not be allowed by another entry, or ask again
	for (const ref of live) ref.deref()?.uninstalled(url);
});
// #endregion
