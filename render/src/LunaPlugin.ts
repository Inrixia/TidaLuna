// Ensure that @triton/lib is loaded onto window for plugins to use shared memory space
import { Semaphore, Signal } from "@inrixia/helpers";
import { unloadSet, type LunaUnloads } from "./helpers/unloadSet";
import { ReactiveStore } from "./ReactiveStore";
import { store as obyStore } from "oby";

import { type LunaUnload } from "@luna/core";
import * as ftch from "./helpers/fetch";
import { codeToImport, isCoreUrl, isDevUrl, nativeFileChanges, sha256Hex, updateWaitsForUser } from "./helpers/pluginUpdates";
import { rawSha256, type RevokedEntry } from "./helpers/registry";
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
	 * (equal to the sha256 of its text as UTF-8 for any file without a BOM, which esbuild never writes).
	 */
	rawSha256?: string;
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

const describeRevoked = (entry: RevokedEntry) => `${entry.reason}${entry.report !== undefined ? ` Report: ${entry.report}` : ""}`;

export class LunaPlugin {
	// #region Static
	public static fetchPackage(url: string): Promise<PluginPackage> {
		return ftch.json<PluginPackage>(`${url}.json`).catch((err) => {
			throw new Error(`Failed to fetch package.json for ${url}: ${err?.message}`);
		});
	}
	public static fetchCode(url: string): Promise<string> {
		return ftch.text(`${url}.mjs`).catch((err) => {
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

	/** Unload loaded plugins whose code is revoked, and drop pending updates that are */
	private static async applyRevocations(): Promise<void> {
		for (const plugin of Object.values(LunaPlugin.plugins)) {
			const pending = plugin.pendingUpdate._;
			if (pending !== undefined && plugin.revokedUpdate(pending) !== undefined) plugin.pendingUpdate._ = undefined;
			if (plugin.exports === undefined) continue;
			const decision = LunaRegistry.loadDecision({ url: plugin.url, rawSha256: plugin.package?.rawSha256 });
			if (!decision.load) await plugin.stopRevoked(decision.revoked);
		}
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
				delete (value as any).package?.code;
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
		this._enabled._ = false;
		this.loadError._ = undefined;
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
		if (revoked !== undefined) {
			if (this.pendingUpdate._?.hash === update.hash) this.pendingUpdate._ = undefined;
			return this.trace.msg.err.throw(`Not updating ${this.name}: the Luna plugin registry revoked ${update.version ?? "this version"}. ${describeRevoked(revoked)}`);
		}
		this.trace.msg.log(`Updating ${this.name} ${this.package?.version ?? ""} -> ${update.version ?? ""}`);
		if (this.enabled) return this.loadExports(true, update);
		const release = await this.loadSemaphore.obtain();
		try {
			this.applyUpdate(update);
		} finally {
			release();
		}
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
	private markRevoked(entry: RevokedEntry) {
		this.loadError._ = `Revoked by the Luna plugin registry: ${entry.reason}`;
		// Once per revocation: live reload calls loadExports every second, and each fetched revoked.json has new entry objects
		if (this.revoked._?.reason === entry.reason && this.revoked._?.report === entry.report) return;
		this.revoked._ = entry;
		this.trace.msg.err(`${this.name} ${this.package?.version ?? ""} was not loaded: the Luna plugin registry revoked it. ${describeRevoked(entry)}`);
	}
	/** Unload this plugin because a newly accepted revoked.json revokes its code. It stays enabled: a version that isn't revoked loads again */
	private async stopRevoked(entry: RevokedEntry): Promise<void> {
		const release = await this.loadSemaphore.obtain();
		try {
			// Checked again: the code may have changed while waiting for the semaphore
			const decision = LunaRegistry.loadDecision({ url: this.url, rawSha256: this.package?.rawSha256 });
			if (decision.load || this.exports === undefined) return;
			await this.unload();
			this.markRevoked(entry);
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
			this.store.package = { ...this.store.package, code: undefined, codeSha256: undefined };

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
	/**
	 * Returns true if code changed, should never be called outside of loadExports
	 */
	private async fetchPackage(): Promise<boolean> {
		try {
			this.fetching._ = true;
			const newPackage = await LunaPlugin.fetchPackage(this.url);
			// Delete this just to be safe
			delete newPackage.code;

			const codeChanged = this.package?.hash !== newPackage.hash;
			// If code hasnt changed then just reuse stored code, or the code of the update already waiting.
			// Its sha256 comes along, never from the url's json (loadExports recomputes it from what it imports)
			const reused = !codeChanged ? this.package : this.pendingUpdate._?.hash === newPackage.hash ? this.pendingUpdate._ : undefined;
			newPackage.code = reused?.code;
			newPackage.codeSha256 = reused?.code !== undefined ? reused.codeSha256 : undefined;
			newPackage.rawSha256 = reused?.code !== undefined ? reused.rawSha256 : undefined;

			// Ensure that code is fetched if its changed or undefined
			newPackage.code ??= `${await LunaPlugin.fetchCode(this.url)}\n//# sourceURL=${this.url}.mjs`;

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
						this.trace.msg.warn(
							`Update of ${this.name} to ${newPackage.version ?? "a new version"} not offered: the Luna plugin registry revoked it. ${describeRevoked(revoked)}`,
						);
						return false;
					}
					this.trace.log(`Update ${this.package?.version ?? ""} -> ${newPackage.version ?? ""} waits for confirmation`);
					this.pendingUpdate._ = newPackage;
					LunaPlugin.announceUpdate(this.name);
				}
				return false;
			}
			this.pendingUpdate._ = undefined;

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
			if (!decision.load) return this.markRevoked(decision.revoked);
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
