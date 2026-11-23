// Ensure that @triton/lib is loaded onto window for plugins to use shared memory space
import { rejectNotOk, Semaphore, Signal } from "@inrixia/helpers";
import { unloadSet, type LunaUnloads } from "./helpers/unloadSet";
import { ReactiveStore } from "./ReactiveStore";
import { store as obyStore } from "oby";

import { type LunaUnload } from "@luna/core";
import * as ftch from "./helpers/fetch";
import { codeToImport, isCoreUrl, isDevUrl, nativeFileChanges, sha256Hex, updateWaitsForUser } from "./helpers/pluginUpdates";
import { asSentence, decodeServedCode, rawSha256, revocationAction, sameServedCode, type RevokedEntry } from "./helpers/registry";
import { LunaRegistry } from "./LunaRegistry";
import { modules } from "./modules";
import { coreTrace, Tracer } from "./trace";

type ModuleExports = {
	unloads?: LunaUnloads;
	onUnload?: LunaUnload;
	Settings?: React.FC;
	errSignal?: Signal<string | undefined>;
};

export type LunaAuthor = {
	name: string;
	url: string;
	avatarUrl?: string;
};
export type PluginPackage = {
	name: string;
	hash: string;
	author?: LunaAuthor | string;
	homepage?: string;
	repository?: {
		type?: string;
		url?: string;
	};
	description?: React.ReactNode;
	version?: string;
	dependencies?: string[];
	devDependencies?: string[];
	code?: string;
	/**
	 * sha256 (hex) of the text Luna imports for `code`, set when it loads or waits as an update.
	 * Not the hash of the served `<url>.mjs` alone. To reproduce it: take the served .mjs text, append `\n//# sourceURL=<url>.mjs`,
	 * apply helpers/pluginUpdates codeToImport(text, url), and sha256 the result as UTF-8.
	 * Not the hash the plugin registry uses, that is `rawSha256`.
	 */
	codeSha256?: string;
	/**
	 * sha256 (hex) of the served `<url>.mjs` itself, the key of the plugin registry's verified.json and revoked.json (see helpers/registry).
	 * The same for every url serving the same file. Set with codeSha256. To reproduce it: sha256 of the .mjs file's bytes
	 * (fetchCode keeps a BOM and refuses invalid UTF-8, so the text encodes back to those bytes).
	 */
	rawSha256?: string;
	/** `code` was fetched by fetchCode as it is now (BOM kept, strict UTF-8), so rawSha256 is the sha256 of the served bytes. Older stored code is fetched again */
	exactCode?: true;
};

// If adding to this make sure that the values are initalized in LunaPlugin.fromStorage
export type LunaPluginStorage = {
	url: string;
	package: PluginPackage;
	enabled: boolean;
	installed: boolean;
	liveReload: boolean;
	hideSettings: boolean;
};

type PartialLunaPluginStorage = Partial<LunaPluginStorage> & { url: string };

const describeRevoked = (entry: RevokedEntry) => `${asSentence(entry.reason)}${entry.report !== undefined ? ` Report: ${entry.report}` : ""}`;

export class LunaPlugin {
	// #region Static
	public static fetchPackage(url: string): Promise<PluginPackage> {
		return ftch.json<PluginPackage>(`${url}.json`).catch((err) => {
			throw new Error(`Failed to fetch package.json for ${url}: ${err?.message}`);
		});
	}
	/**
	 * The served .mjs as text that encodes back to exactly the served bytes, so its rawSha256 is the registry's sha256 of the file:
	 * a BOM is kept, and a file that isn't valid UTF-8 is refused (decoding would replace bytes and dodge a revocation)
	 */
	public static fetchCode(url: string): Promise<string> {
		return fetch(`${url}.mjs`)
			.then(rejectNotOk)
			.then((res) => res.arrayBuffer())
			.then((bytes) => decodeServedCode(bytes))
			.catch((err) => {
				throw new Error(`Failed to fetch code for ${url}: ${err?.message}`);
			});
	}

	// Store urls are saved without the trailing /store.json
	public static normalizeStoreUrl(url: string): string {
		return url.endsWith("/store.json") ? url.slice(0, -11) : url;
	}
	// Url of a plugin listed in a store's store.json (spaces become dots, except in the local dev store)
	public static storePluginUrl(storeUrl: string, entry: string): string {
		return `${storeUrl}/${storeUrl === "http://127.0.0.1:3000" ? entry : entry.replaceAll(" ", ".")}`;
	}

	// Storage backing for persisting plugin url/enabled/code etc... See LunaPluginStorage
	public static readonly pluginStorage: ReactiveStore = ReactiveStore.getStore("@luna/plugins");
	// Static store for all loaded plugins indexed by URL (allows multiple instances for display)
	public static readonly plugins = obyStore<Record<string, LunaPlugin>>({});

	/**
	 * Find a plugin by name, prioritizing installed versions
	 */
	public static getByName(name: string): LunaPlugin | undefined {
		const all = this.getAllByName(name);
		return all.find((p) => p.installed) ?? all[0];
	}

	/**
	 * Find all plugin instances with a given name (e.g., DEV + GitHub versions)
	 */
	public static getAllByName(name: string): LunaPlugin[] {
		return Object.values(this.plugins).filter((p) => p.name === name);
	}

	// Static list of Luna plugins that should be seperate from user plugins
	public static readonly corePlugins: Set<string> = new Set(["@luna/lib", "@luna/lib.native", "@luna/ui", "@luna/dev", "@luna/linux"]);

	static {
		// Unload all plugins when main process signals window is closing
		__ipcRenderer.on("window.close", () => {
			for (const plugin of Object.values(LunaPlugin.plugins)) {
				plugin.unload().catch((err) => {
					const errMsg = `[Luna] Failed to unload plugin ${plugin.name}! Please report this to the Luna devs. ${err?.message}`;
					// Use alert here over logErr as Tidal may be partially unloaded
					alert(errMsg);
					console.error(errMsg, err);
				});
			}
		});
		__ipcRenderer.on("__Luna.LunaPlugin.addDependant", (pluginName, dependantName) => {
			const plugin = LunaPlugin.getByName(pluginName);
			const dependantPlugin = LunaPlugin.getByName(dependantName);
			const errTrace = coreTrace.msg.err.withContext(`__ipcRenderer.on("__Luna.LunaPlugin.addDependant")`);
			if (plugin === undefined) return errTrace.throw(`Plugin ${pluginName} not found!`);
			if (dependantPlugin === undefined) return errTrace.throw(`Dependancy ${dependantName} of ${pluginName} not found!`);

			plugin.addDependant(dependantPlugin);
		});
	}

	/**
	 * Unload loaded plugins whose code is revoked, drop pending updates that are, and load again enabled plugins a revocation stopped
	 * whose code is no longer revoked. A plugin still loading checks again after its import (see loadExports)
	 */
	private static async applyRevocations(): Promise<void> {
		const stops: Promise<void>[] = [];
		const loads: LunaPlugin[] = [];
		for (const plugin of Object.values(LunaPlugin.plugins)) {
			plugin.dropRevokedPending();
			plugin.offerLiftedUpdate();
			const next = revocationAction(
				{
					url: plugin.url,
					rawSha256: plugin.package?.rawSha256,
					loaded: plugin.exports !== undefined,
					stoppedByRevocation: plugin.revoked._ !== undefined,
					enabled: plugin.enabled && plugin.installed !== false,
				},
				LunaRegistry.revoked._,
			);
			if (next.action === "stop") stops.push(plugin.stopRevoked().catch(plugin.trace.err.withContext("Failed to stop revoked plugin")));
			else if (next.action === "load") loads.push(plugin);
		}
		// Every revoked plugin stops at once, before any plugin loads again (a slow plugin or fetch doesn't hold the others up)
		await Promise.all(stops);
		await Promise.all(
			loads.map((plugin) => {
				plugin.trace.log("No longer revoked, loading again");
				return plugin.reload().catch(plugin.trace.err.withContext("Failed to load again after the revocation was lifted"));
			}),
		);
	}

	/**
	 * Create a plugin instance from a store:LunaPluginStorage, if package is not populated it will be fetched using the url so we can get the name
	 */
	public static async fromStorage(storeInit: PartialLunaPluginStorage): Promise<LunaPlugin> {
		// Ensure the url is sanitized incase users paste a link to the actual file
		storeInit.url = storeInit.url.replace(/(\.mjs|\.json|\.mjs.map)$/, "");

		// Return existing instance if same URL already loaded
		const existingPlugin = this.plugins[storeInit.url];
		if (existingPlugin) {
			// Check if another version is now installed - update state accordingly
			const otherInstalled = this.getAllByName(existingPlugin.name).find((p) => p !== existingPlugin && p.installed);
			if (otherInstalled) {
				existingPlugin.store.installed = false;
				existingPlugin.store.enabled = false;
			}
			return existingPlugin;
		}

		let name = storeInit.package?.name;
		if (name === undefined) {
			storeInit.package ??= await this.fetchPackage(storeInit.url);
			name = storeInit.package.name;
		}

		// Disable liveReload on load so people dont accidentally leave it on
		storeInit.liveReload = false;

		const createNonPersistedStore = () => obyStore({ ...storeInit, installed: false, enabled: false }) as LunaPluginStorage;

		let store: LunaPluginStorage;
		// Get persisted store to check if this URL matches
		const persistedStore = await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>(name);
		if (persistedStore.url === undefined || persistedStore.url === storeInit.url) {
			// First time loading or this is the persisted version - use persisted store
			store = persistedStore;
			Object.assign(store, storeInit);
		} else {
			// Different URL than persisted - create non-persisted reactive store for display only
			store = createNonPersistedStore();
		}

		const plugin = (this.plugins[storeInit.url] ??= new this(name, store));
		return plugin.load();
	}

	public static async fromName(name: string): Promise<LunaPlugin | undefined> {
		const existing = this.getByName(name);
		if (existing) return existing;

		const store = await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>(name);
		if (store === undefined || store.url === undefined) return;

		return this.fromStorage(store);
	}

	// Moves installed plugins to a new store url <3
	public static async migrateBaseUrl(fromBaseUrl: string, toBaseUrl: string): Promise<void> {
		const fromPrefix = `${fromBaseUrl}/`.toLowerCase();
		for (const name of await this.pluginStorage.keys()) {
			const store = await this.pluginStorage.getReactive<LunaPluginStorage>(name);
			if (!store.url?.toLowerCase().startsWith(fromPrefix)) continue;

			const newUrl = `${toBaseUrl}/${store.url.slice(fromPrefix.length)}`;
			// Re-key loaded plugin so it isnt duplicated <3
			const plugin = this.plugins[store.url];
			if (plugin !== undefined) {
				delete this.plugins[store.url];
				this.plugins[newUrl] = plugin;
			}
			this.trace.log(`Migrating plugin ${name} from ${store.url} to ${newUrl}`);
			store.url = newUrl;
		}
	}

	public static async loadStoredPlugins() {
		const keys = await LunaPlugin.pluginStorage.keys();
		return Promise.all(keys.map(async (name) => LunaPlugin.fromName(name).catch(this.trace.err.withContext("loadStoredPlugins", name))));
	}

	/**
	 * Reload every installed and enabled plugin, except core plugins, one at a time.
	 * A plugin that depends on another plugin being reloaded is skipped, reloading that plugin reloads its dependants.
	 * @returns The plugins that failed to reload (each one also reports its own error), including dependants of a failed plugin, which are left unloaded
	 */
	public static async reloadAll(): Promise<LunaPlugin[]> {
		const plugins = Object.values(LunaPlugin.plugins).filter(
			(plugin) => plugin.installed && plugin.enabled && !LunaPlugin.corePlugins.has(plugin.name),
		);
		const failed: LunaPlugin[] = [];
		const dependants: LunaPlugin[] = [];
		for (const plugin of plugins) {
			if (plugins.some((other) => other !== plugin && other.dependants.has(plugin))) {
				dependants.push(plugin);
				continue;
			}
			try {
				await plugin.reload();
			} catch {
				failed.push(plugin);
			}
		}
		// A failed plugin unloads its dependants and doesn't load them again.
		// for...of also visits the dependants pushed here, so chains (A -> B -> C) are covered.
		for (const plugin of failed) {
			for (const dependant of dependants) {
				if (plugin.dependants.has(dependant) && !failed.includes(dependant)) failed.push(dependant);
			}
		}
		return failed;
	}

	/**
	 * Dump all plugin storage entries
	 */
	public static async dumpStorage(stripCode: boolean = true): Promise<Record<string, unknown>>
	{
		const data = await this.pluginStorage.dump();
		if (!stripCode) 
			return data;

		const stripped = structuredClone(data);
		for (const value of Object.values(stripped))
		{
			if (value && typeof value === "object")
			{
				delete (value as any).package?.code;
				// The hashes describe that code: without it they would badge code that isn't there
				delete (value as any).package?.codeSha256;
				delete (value as any).package?.rawSha256;
				delete (value as any).package?.exactCode;
			}
		}

		return stripped;
	}
	// #endregion

	// #region Tracer
	public static readonly trace: Tracer = coreTrace.withSource(".LunaPlugin").trace;
	static {
		// A newly accepted revoked.json stops the plugins it revokes (at startup plugins load before the fetch finishes, see LunaRegistry).
		// Here, after trace: onValue calls the listener right away
		LunaRegistry.revoked.onValue(() => LunaPlugin.applyRevocations().catch(LunaPlugin.trace.err.withContext("applyRevocations")));
	}
	public readonly trace: Tracer;
	// #endregion

	// #region constructor
	private constructor(
		public readonly name: string,
		public readonly store: LunaPluginStorage,
	) {
		const devSuffix = this.store.url.startsWith("http://127.0.0.1") ? " [DEV]" : "";
		this.trace = LunaPlugin.trace.withSource(`[${this.name}]${devSuffix}`).trace;
		// Enabled has to be setup first because liveReload below accesses it
		this._enabled = new Signal(this.store.enabled, (next) => {
			// Protect against disabling permanantly in the background if loading causes a error
			// Restarting the client will attempt to load again
			if (this.loadError._ === undefined) this.store.enabled = next;
		});
		// Allow other code to listen to onEnabled (this._enabled is private)
		this.onSetEnabled = this._enabled.onValue.bind(this._enabled);

		this._liveReload = new Signal(this.store.liveReload, (next) => {
			if ((this.store.liveReload = next)) this.startReloadLoop();
			else this.stopReloadLoop();
		});
		this.onSetLiveReload = this._liveReload.onValue.bind(this._liveReload);
	}
	// #endregion

	// #region reloadLoop
	private _reloadTimeout?: NodeJS.Timeout;
	private startReloadLoop() {
		if (this._reloadTimeout) return;
		const reloadLoop = async () => {
			// Fail quietly
			await this.loadExports().catch(() => {});
			// Dont continue to loop if disabled or liveReload is false
			if (!this.enabled || !this._liveReload._) return;
			this._reloadTimeout = setTimeout(reloadLoop.bind(this), 1000);
		};
		// Immediately set reloadTimeout to avoid entering this multiple times
		this._reloadTimeout = setTimeout(reloadLoop);
	}
	private stopReloadLoop() {
		clearTimeout(this._reloadTimeout);
		this._reloadTimeout = undefined;
	}
	// #endregion

	// #region Signals
	public readonly loading: Signal<boolean> = new Signal(false);
	public readonly fetching: Signal<boolean> = new Signal(false);
	public readonly loadError: Signal<string | undefined> = new Signal(undefined);

	public readonly _liveReload: Signal<boolean>;
	public onSetLiveReload;
	public get liveReload() {
		return this._liveReload._;
	}
	public set liveReload(value: boolean) {
		this._liveReload._ = value;
	}

	private readonly _enabled: Signal<boolean>;
	public onSetEnabled;
	public get enabled() {
		return this._enabled._;
	}
	// #endregion

	// #region Dependants
	public readonly dependants: Set<LunaPlugin> = new Set();
	public addDependant(plugin: LunaPlugin) {
		if (!(plugin instanceof LunaPlugin)) throw new Error("Cannot add dependancy to non plugin!");
		this.dependants.add(plugin);
	}
	/**
	 * Another enabled plugin that `dependant` depends on and that has not finished loading, if any.
	 * That plugin will load `dependant` itself once its own exports are available.
	 */
	private pendingDependencyOf(dependant: LunaPlugin): LunaPlugin | undefined {
		for (const plugin of Object.values(LunaPlugin.plugins)) {
			if (plugin === this || plugin === dependant) continue;
			if (!plugin.dependants.has(dependant)) continue;
			if (plugin.enabled && plugin.installed !== false && plugin.exports === undefined) return plugin;
		}
		return undefined;
	}
	// #endregion

	// #region _exports
	public get exports(): ModuleExports | undefined {
		return modules[this.name];
	}
	private set exports(exports: ModuleExports | undefined) {
		if (this._unloads.size !== 0) {
			// If we always unload on load then we should never be here
			this.trace.msg.warn(`Plugin ${this.name} is trying to set exports but unloads are not empty! Please report this to the Luna devs.`);
			// This is a safety check to ensure we dont leak unloads
			// If there is somehow leftover unloads we need to add them to the new exports.unloads if it exists
			if (exports?.unloads !== undefined) {
				for (const unload of this._unloads) exports.unloads.add(unload);
				this._unloads.clear();
			}
		}
		modules[this.name] = exports;
	}
	private readonly _unloads: LunaUnloads = new Set();
	private get unloads() {
		return this.exports?.unloads ?? this._unloads;
	}
	// #endregion

	// #region Storage
	/**
	 * The non-core plugin whose bundle threw, found from the topmost stack frame that belongs to one.
	 * Plugin code runs from a blob with `//# sourceURL=<url>.mjs`, so its frames carry that url.
	 */
	public static fromStack(stack?: string): LunaPlugin | undefined {
		if (stack === undefined) return undefined;
		const plugins = Object.values(LunaPlugin.plugins).filter((plugin) => !LunaPlugin.corePlugins.has(plugin.name) && plugin.url.length > 0);
		for (const frame of stack.split("\n")) {
			const plugin = plugins.find((plugin) => frame.includes(`${plugin.url}.mjs`));
			if (plugin !== undefined) return plugin;
		}
		return undefined;
	}

	/** Show an error that happened after the plugin loaded (e.g. in one of its listeners) on its card */
	public setLoadError(message: string): void {
		this.loadError._ = message;
	}

	public get url(): string {
		return this.store.url;
	}
	public get package(): PluginPackage | undefined {
		return this.store.package;
	}
	public get code(): string | undefined {
		return this.package?.code;
	}
	private set package(value: PluginPackage) {
		this.store.package = value;
	}
	public get installed(): boolean {
		return this.store.installed;
	}
	public get isDev(): boolean {
		return isDevUrl(this.url);
	}
	// #endregion

	// #region load/unload
	/**
	 * Are you sure you didnt mean disable() or reload()?
	 * This will unload the plugin without disabling it!
	 */
	private async unload(): Promise<void> {
		const wasLoaded = this.exports !== undefined;
		try {
			this.loading._ = true;
			// Unload dependants before unloading this plugin
			for (const dependant of this.dependants) {
				this.trace.log(`Unloading dependant ${dependant.name}`);
				await dependant.unload();
			}
			await unloadSet(this.exports?.unloads);
		} finally {
			this.exports = undefined;
			this.loading._ = false;
			delete modules[this.name];
			if (wasLoaded) this.trace.log("Unloaded");
		}
	}
	/**
	 * Load the plugin if it is enabled
	 */
	public async load(): Promise<LunaPlugin> {
		if (this.enabled && this.installed !== false) await this.enable();
		return this;
	}
	// #endregion

	// #region enable/disable
	public async enable() {
		try {
			this.loading._ = true;
			await this.loadExports();
			this._enabled._ = true;
			this.store.installed = true;
			// Ensure live reload is running it it should be
			if (this._liveReload._) this.startReloadLoop();
		} finally {
			this.loading._ = false;
		}
	}
	public async disable() {
		// Disable the reload loop
		this.stopReloadLoop();
		await this.unload();
		// Cleared first: the user's choice is stored only while there is no load error (a revoked plugin has one)
		this.loadError._ = undefined;
		this._enabled._ = false;
	}
	public async reload() {
		// LoadExports will handle unloading etc and ensure code is live
		await this.loadExports(true);
	}
	// #endregion

	// #region updates
	/**
	 * New code fetched for this plugin that the user has not accepted yet, as its package with code.
	 * The stored code keeps running until acceptUpdate. Refetched each time the plugin loads (client start, reload).
	 */
	public readonly pendingUpdate: Signal<PluginPackage | undefined> = new Signal(undefined);
	/**
	 * Store the update and run it if the plugin is enabled.
	 * @param update The update the user was shown. If the url has served a newer one since, that one becomes the pending update.
	 */
	public async acceptUpdate(update: PluginPackage | undefined = this.pendingUpdate._): Promise<void> {
		if (update?.code === undefined) return;
		// Hashed here from the code that would be stored, not taken from the package: any caller can hand one in
		const raw = await rawSha256(update.code);
		if (update.rawSha256 !== raw) update = { ...update, rawSha256: raw };
		const revoked = this.revokedUpdate(update);
		if (revoked !== undefined) return this.refuseUpdate(update, revoked);
		this.trace.msg.log(`Updating ${this.name} ${this.package?.version ?? ""} -> ${update.version ?? ""}`);
		if (this.enabled) {
			const previous = this.package;
			await this.loadExports(true, update);
			// Revoked while or just after it loaded (loadExports already said why): the version the user had runs again
			if (this.revokedUpdate(update) === undefined) return;
			await this.rollBackRevokedUpdate(update, previous);
			throw new Error(`Not updating ${this.name}: the Luna plugin registry revoked ${update.version ?? "this version"}`);
		}
		const release = await this.loadSemaphore.obtain();
		try {
			// Checked again: the list may have changed while waiting for the semaphore
			const revokedNow = this.revokedUpdate(update);
			if (revokedNow !== undefined) return this.refuseUpdate(update, revokedNow);
			this.applyUpdate(update);
		} finally {
			release();
		}
	}
	/** Put back the version an accepted update replaced, if the update is still stored (revoked after it loaded), and load it */
	private async rollBackRevokedUpdate(update: PluginPackage, previous: PluginPackage | undefined): Promise<void> {
		const release = await this.loadSemaphore.obtain();
		try {
			if (previous === undefined || this.package?.hash !== update.hash) return;
			await this.unload();
			this.package = previous;
			this.refusedHash = update.hash;
			this.refusedUpdate = update;
		} finally {
			release();
		}
		await this.reload().catch(this.trace.err.withContext("Failed to load the previous version again"));
	}
	/** Drop a revoked update and say why. Throws */
	private refuseUpdate(update: PluginPackage, revoked: RevokedEntry): never {
		if (this.pendingUpdate._?.hash === update.hash) this.pendingUpdate._ = undefined;
		return this.trace.msg.err.throw(`Not updating ${this.name}: the Luna plugin registry revoked ${update.version ?? "this version"}. ${describeRevoked(revoked)}`);
	}
	/**
	 * Call while holding loadSemaphore.
	 * @returns The package it replaced, to put back if the update fails to load
	 */
	private applyUpdate(update: PluginPackage): PluginPackage | undefined {
		const previous = this.package;
		this.package = update;
		if (this.pendingUpdate._?.hash === update.hash) this.pendingUpdate._ = undefined;
		return previous;
	}
	/** The registry's revocation of an update's code, if it is revoked (Luna's own plugins are never) */
	public revokedUpdate(update: PluginPackage): RevokedEntry | undefined {
		const decision = LunaRegistry.loadDecision({ url: this.url, rawSha256: update.rawSha256 });
		return decision.load ? undefined : decision.revoked;
	}
	/** The native files of an update and which it adds or removes, for display (see helpers/pluginUpdates) */
	public static readonly nativeFileChanges = nativeFileChanges;

	private static readonly announcedUpdates: Set<string> = new Set();
	private static announceTimeout?: ReturnType<typeof setTimeout>;
	/** One message for the updates found while plugins load (the client loads them all at start, dependants later) */
	private static announceUpdate(name: string) {
		LunaPlugin.announcedUpdates.add(name);
		clearTimeout(LunaPlugin.announceTimeout);
		LunaPlugin.announceTimeout = setTimeout(() => {
			const names = [...LunaPlugin.announcedUpdates].join(", ");
			LunaPlugin.announcedUpdates.clear();
			coreTrace.msg.log(`Plugin updates are waiting for you: ${names}. Review them in Luna Settings > Plugins`);
		}, 2000);
	}
	// #endregion

	// #region registry
	/** The registry's revocation of the code this plugin has, set when it refused to load it (see LunaRegistry) */
	public readonly revoked: Signal<RevokedEntry | undefined> = new Signal(undefined);
	/** The raw sha256 `revoked` is for */
	private revokedSha256?: string;
	private markRevoked(entry: RevokedEntry) {
		this.loadError._ = `Revoked by the Luna plugin registry: ${entry.reason}`;
		// Unloading this plugin unloaded its dependants too: say why on their cards
		for (const dependant of this.dependants)
			if (dependant.exports === undefined) dependant.loadError._ = `Not running: it depends on ${this.name}, which the Luna plugin registry revoked`;
		// Once per revoked build: live reload calls loadExports every second, and each fetched revoked.json has new entry objects
		const sha = this.package?.rawSha256;
		if (this.revokedSha256 === sha && this.revoked._?.reason === entry.reason && this.revoked._?.report === entry.report) return;
		this.revokedSha256 = sha;
		this.revoked._ = entry;
		this.trace.msg.err(`${this.name} ${this.package?.version ?? ""} was not loaded: the Luna plugin registry revoked it. ${describeRevoked(entry)}`);
	}
	/**
	 * After loadExports found the code it was loading revoked (and unloaded): mark it, and if that code was an update the user accepted,
	 * store the version they had again and load it
	 */
	private stopAsRevoked(entry: RevokedEntry, replaced: { previous: PluginPackage | undefined } | undefined, update: PluginPackage | undefined) {
		this.markRevoked(entry);
		if (replaced?.previous === undefined || update === undefined || this.package?.hash !== update.hash) return;
		this.package = replaced.previous;
		// The reload below fetches it again: already announced, and offered if the revocation is lifted
		this.refusedHash = update.hash;
		this.refusedUpdate = update;
		// Run it again once this load has released the semaphore
		setTimeout(() => this.reload().catch(this.trace.err.withContext("Failed to load the previous version again")));
	}
	/** Unload this plugin because a newly accepted revoked.json revokes its code. It stays enabled: a version that isn't revoked loads again */
	private async stopRevoked(): Promise<void> {
		const release = await this.loadSemaphore.obtain();
		try {
			// Checked again: the code may have changed while waiting for the semaphore
			const decision = LunaRegistry.loadDecision({ url: this.url, rawSha256: this.package?.rawSha256 });
			if (decision.load || this.exports === undefined) return;
			await this.unload();
			this.markRevoked(decision.revoked);
		} finally {
			release();
		}
	}
	// #endregion

	// #region install/uninstall
	public async install() {
		this.loading._ = true;
		// Uninstall can leave the old package, code included, in storage: install what the url serves now instead of offering it as an update
		if (!this.installed && this.store.package?.code !== undefined)
			this.store.package = { ...this.store.package, code: undefined, codeSha256: undefined, rawSha256: undefined };

		// Uninstall other versions of the same plugin (e.g., switching from GitHub to DEV)
		const otherVersions = LunaPlugin.getAllByName(this.name).filter((p) => p !== this && p.installed);
		for (const other of otherVersions) {
			coreTrace.msg.log(`Switching plugin ${this.name} from ${other.url} to ${this.url}`);
			await other.uninstall();
		}

		// Update persisted store with this plugin's URL so it loads on restart
		const persistedStore = await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>(this.name);
		persistedStore.url = this.url;
		persistedStore.package = this.store.package;
		persistedStore.installed = true;
		persistedStore.enabled = true;

		this.store.installed = true;
		await this.enable();
		coreTrace.msg.log(`Installed plugin ${this.name}${this.isDev ? " [DEV]" : ""}`);
	}
	public async uninstall() {
		await this.disable();
		this.loading._ = true;
		// Remove this plugin from all dependants lists
		for (const plugin of Object.values(LunaPlugin.plugins)) {
			plugin.dependants.delete(this);
		}
		this.store.installed = false;
		this.pendingUpdate._ = undefined;
		delete LunaPlugin.plugins[this.url];
		await LunaPlugin.pluginStorage.del(this.name);
		// A reinstall asks for native permissions again
		await __ipcRenderer.invoke("__Luna.nativePermissions.forget", this.url).catch(this.trace.err.withContext("Failed to forget native permissions"));
		this.loading._ = false;
		coreTrace.msg.log(`Uninstalled plugin ${this.name}${this.isDev ? " [DEV]" : ""}`);
	}
	// #endregion

	// #region Fetch
	/** The hash of the last fetched build refused as revoked, so it is announced once */
	private refusedHash?: string;
	/** The last update refused as revoked, offered after all if its revocation is lifted (see offerLiftedUpdate) */
	private refusedUpdate?: PluginPackage;
	/** Drop the pending update if the list in use revokes it, say so once, and remember it in case the revocation is lifted */
	private dropRevokedPending() {
		const pending = this.pendingUpdate._;
		const revoked = pending !== undefined ? this.revokedUpdate(pending) : undefined;
		if (pending === undefined || revoked === undefined) return;
		this.pendingUpdate._ = undefined;
		if (this.refusedHash !== pending.hash)
			this.trace.msg.warn(
				`Update of ${this.name} to ${pending.version ?? "a new version"} withdrawn: the Luna plugin registry revoked it. ${describeRevoked(revoked)}`,
			);
		this.refusedHash = pending.hash;
		this.refusedUpdate = pending;
	}
	/** Offer an update that was refused as revoked once the registry no longer revokes it */
	private offerLiftedUpdate() {
		const refused = this.refusedUpdate;
		if (refused === undefined || this.revokedUpdate(refused) !== undefined) return;
		this.refusedUpdate = undefined;
		this.refusedHash = undefined;
		// Only if it is still what the url served last and nothing newer waits
		if (this.pendingUpdate._ !== undefined || this.package?.hash === refused.hash) return;
		this.trace.log(`Update ${this.package?.version ?? ""} -> ${refused.version ?? ""} no longer revoked, waits for confirmation`);
		this.pendingUpdate._ = refused;
		LunaPlugin.announceUpdate(this.name);
	}
	/**
	 * Returns true if code changed, should never be called outside of loadExports
	 */
	private async fetchPackage(): Promise<boolean> {
		try {
			this.fetching._ = true;
			const newPackage = await LunaPlugin.fetchPackage(this.url);
			// Delete this just to be safe
			delete newPackage.code;
			// The url serves something else now: a refused update is not offered later (see offerLiftedUpdate)
			if (this.refusedUpdate !== undefined && this.refusedUpdate.hash !== newPackage.hash) this.refusedUpdate = undefined;

			let codeChanged = this.package?.hash !== newPackage.hash;
			// If code hasnt changed then just reuse stored code, or the code of the update already waiting.
			// Its sha256 comes along, never from the url's json (loadExports recomputes it from what it imports)
			const known = !codeChanged ? this.package : this.pendingUpdate._?.hash === newPackage.hash ? this.pendingUpdate._ : undefined;
			// Code stored before fetchCode kept BOMs and refused invalid UTF-8 is fetched again until that succeeds,
			// so its hash is the registry's (if the fetch fails, the stored code stays for now)
			const reused = known?.exactCode ? known : undefined;
			newPackage.code = reused?.code;
			newPackage.codeSha256 = reused?.code !== undefined ? reused.codeSha256 : undefined;
			newPackage.rawSha256 = reused?.code !== undefined ? reused.rawSha256 : undefined;

			// Ensure that code is fetched if its changed or undefined
			if (newPackage.code === undefined) newPackage.code = `${await LunaPlugin.fetchCode(this.url)}\n//# sourceURL=${this.url}.mjs`;
			newPackage.exactCode = true;
			// Code fetched again only to read its exact bytes is an update when it differs from what is stored (beyond a BOM),
			// so it waits for the user like any other update instead of replacing the stored code silently
			if (!codeChanged && known?.code !== undefined && !known.exactCode && !sameServedCode(known.code, newPackage.code)) codeChanged = true;

			// New code for a plugin that already has code waits for the user (see acceptUpdate), the stored code keeps running
			const waits = updateWaitsForUser({
				codeChanged,
				hasCode: this.code !== undefined,
				isDev: this.isDev,
				liveReload: this._liveReload._,
				isCore: isCoreUrl(this.url),
			});
			if (waits) {
				// The same update fetched again keeps its object, so an open update dialog still matches it
				if (this.pendingUpdate._?.hash !== newPackage.hash) {
					newPackage.codeSha256 = await sha256Hex(codeToImport(newPackage.code, this.url));
					newPackage.rawSha256 = await rawSha256(newPackage.code);
					// A revoked update is not offered (acceptUpdate refuses it too)
					const revoked = this.revokedUpdate(newPackage);
					if (revoked !== undefined) {
						// Once per build and session: reloads fetch it again
						if (this.refusedHash !== newPackage.hash)
							this.trace.msg.warn(
								`Update of ${this.name} to ${newPackage.version ?? "a new version"} not offered: the Luna plugin registry revoked it. ${describeRevoked(revoked)}`,
							);
						this.refusedHash = newPackage.hash;
						this.refusedUpdate = newPackage;
						return false;
					}
					this.trace.log(`Update ${this.package?.version ?? ""} -> ${newPackage.version ?? ""} waits for confirmation`);
					this.pendingUpdate._ = newPackage;
					LunaPlugin.announceUpdate(this.name);
				}
				return false;
			}
			this.pendingUpdate._ = undefined;

			// New code that replaces stored code without asking (dev, live reload) is not taken if it is revoked: the stored code stays
			if (codeChanged && this.code !== undefined) {
				newPackage.rawSha256 ??= await rawSha256(newPackage.code);
				const revoked = this.revokedUpdate(newPackage);
				if (revoked !== undefined) {
					// Once per build: live reload fetches every second
					if (this.refusedHash !== newPackage.hash)
						this.trace.msg.warn(`New code of ${this.name} not loaded: the Luna plugin registry revoked it. ${describeRevoked(revoked)}`);
					this.refusedHash = newPackage.hash;
					return false;
				}
			}

			// Only replace the stored package once its code is fetched, so a failed fetch keeps the cached code
			this.package = newPackage;

			return codeChanged;
		} catch {
			// Fail silently if we cant fetch
		} finally {
			this.fetching._ = false;
		}
		return false;
	}
	// #endregion

	// #region Load
	private readonly loadSemaphore: Semaphore = new Semaphore(1);
	/**
	 * @param update A pending update the user accepted, stored before fetching (see acceptUpdate)
	 */
	private async loadExports(reload?: true, update?: PluginPackage): Promise<void> {
		// Ensure we cant start loading midway through loading
		const release = await this.loadSemaphore.obtain();
		// The list may have changed while waiting for the semaphore: a revoked update replaces nothing and the running version keeps running
		const revokedUpdate = update !== undefined ? this.revokedUpdate(update) : undefined;
		if (revokedUpdate !== undefined) {
			release();
			return this.refuseUpdate(update!, revokedUpdate);
		}
		let replaced: { previous: PluginPackage | undefined } | undefined;
		try {
			if (update !== undefined) replaced = { previous: this.applyUpdate(update) };
			// If code hasnt changed and we have already loaded exports we are done
			const codeChanged = await this.fetchPackage();
			if (!reload && !codeChanged && this.exports !== undefined) return;

			// If code failed to fetch then nothing we can do
			if (this.code === undefined) return;
			this.loading._ = true;

			// Ensure we unload if previously loaded
			await this.unload();

			// Name this plugin's url when its native code registers, so its permissions are kept per plugin (see native/NativeModule/trust.ts)
			// Only the call build/plugins/lunaNativePlugin.ts emits, not the same text inside a native file's code string
			const code = codeToImport(this.code, this.url);
			// Keep the hash of exactly what runs beside the code (the json `hash` only says the code changed), and the registry's key
			const [sha256, raw] = await Promise.all([sha256Hex(code), rawSha256(this.code)]);
			if (this.package!.codeSha256 !== sha256 || this.package!.rawSha256 !== raw) this.package = { ...this.package!, codeSha256: sha256, rawSha256: raw };

			// Code the registry revoked doesn't run (the list in use, see LunaRegistry for startup order)
			const decision = LunaRegistry.loadDecision({ url: this.url, rawSha256: raw });
			if (!decision.load) return this.stopAsRevoked(decision.revoked, replaced, update);
			this.revoked._ = undefined;

			const blobURL = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
			try {
				this.exports = await import(blobURL);
			} finally {
				// The imported module stays alive; the blob would otherwise keep a copy of the code per load
				URL.revokeObjectURL(blobURL);
			}
			if (this.exports === undefined) return this.trace.err.throw(`Failed to load. Module exports undefined!`);

			// Ensure loadError is cleared
			this.loadError._ = undefined;

			const { onUnload, errSignal } = this.exports;

			if (onUnload !== undefined) {
				onUnload.source = "onUnload";
				this.unloads.add(onUnload);
			}
			if (errSignal !== undefined) {
				const unloadErrSignal: LunaUnload = errSignal.onValue((next) => (this.loadError._ = next));
				unloadErrSignal.source = "errSignal";
				this.unloads.add(unloadErrSignal);
			}

			// Prefix all unload sources with plugin name
			for (const unload of this.unloads) {
				unload.source = this.name + (unload.source ? `.${unload.source}` : "");
			}

			// A revoked.json accepted during the import: applyRevocations skipped this plugin (no exports yet), so it is stopped here,
			// once its unloads are known
			const late = LunaRegistry.loadDecision({ url: this.url, rawSha256: raw });
			if (!late.load) {
				await this.unload();
				return this.stopAsRevoked(late.revoked, replaced, update);
			}

			this.trace.log("Loaded");
			// Make sure we load any enabled dependants, this is mostly to facilitate live reloading dependency trees
			for (const dependant of this.dependants) {
				// If the dependant also depends on another enabled plugin that is not loaded yet, leave it to that plugin.
				// It stays in that plugin's dependants and is loaded once that plugin finishes loading.
				// Loading it now would race and fail with "Cannot find module ... in luna.core.modules".
				const pendingDependency = this.pendingDependencyOf(dependant);
				if (pendingDependency !== undefined) {
					this.trace.log(`Deferring dependant ${dependant.name} until ${pendingDependency.name} is loaded`);
					continue;
				}
				// Remove dependant, dependant.load() will add it back if its still a dependant
				this.dependants.delete(dependant);
				this.trace.log(`Loading dependant ${dependant.name}`);
				dependant.load().catch(this.trace.err.withContext(`Failed to load dependant ${dependant.name} of plugin ${this.name}`));
			}
		} catch (err) {
			// Set loadError for anyone listening
			this.loadError._ = (<any>err)?.message ?? err?.toString();
			// Notify users
			this.trace.msg.err.withContext(`Failed to load`)(err);
			// Ensure we arnt partially loaded
			await this.unload();
			// An accepted update that fails to load waits again, the version the user had is the one stored (and runs on the next load)
			if (replaced !== undefined && update !== undefined && this.package?.hash === update.hash) {
				if (replaced.previous !== undefined) this.package = replaced.previous;
				// Unless the url served a newer update meanwhile
				if (this.pendingUpdate._ === undefined) this.pendingUpdate._ = update;
			}
			// For sanity throw the error just to be safe
			throw err;
		} finally {
			release();
			this.loading._ = false;
		}
	}
	// #endregion
}
