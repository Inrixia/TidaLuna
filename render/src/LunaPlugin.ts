// Ensure that @triton/lib is loaded onto window for plugins to use shared memory space
import { rejectNotOk, Semaphore, Signal } from "@inrixia/helpers";
import { unloadSet, type LunaUnloads } from "./helpers/unloadSet";
import { ReactiveStore } from "./ReactiveStore";
import { store as obyStore } from "oby";

import { type LunaUnload } from "@luna/core";
import * as ftch from "./helpers/fetch";
import { allowedForAllVersions, codeToImport, isCoreUrl, isDevUrl, sha256Hex, updateLinks, updateWaitsForUser } from "./helpers/pluginUpdates";
import {
	asSentence,
	changedDependency,
	decodeServedCode,
	dependencyWaitMessage,
	dependsOnAny,
	keepsLiveReloading,
	legacyBomSha256,
	packageSha256s,
	rawSha256,
	revocationAction,
	sameServedCode,
	versionToRestore,
	type RevokedEntry,
} from "./helpers/registry";
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
	/** The commit the plugin was built from, when its CI set it (build/plugins/buildSource.ts) */
	commit?: string;
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
	/**
	 * Only for code stored before exactCode (kept while an update waits, as the url no longer serves it): the sha256 with a leading BOM put back,
	 * the file's other possible registry key (see helpers/registry legacyBomSha256). The registry is checked for both
	 */
	bomRawSha256?: string;
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
		const stops: LunaPlugin[] = [];
		const loads: LunaPlugin[] = [];
		for (const plugin of Object.values(LunaPlugin.plugins)) {
			plugin.dropRevokedPending();
			plugin.offerLiftedUpdate();
			const next = revocationAction(
				{
					url: plugin.url,
					rawSha256: packageSha256s(plugin.package),
					loaded: plugin.exports !== undefined,
					stoppedByRevocation: plugin.revoked._ !== undefined,
					enabled: plugin.enabled && plugin.installed !== false,
				},
				LunaRegistry.revoked._,
			);
			if (next.action === "stop") stops.push(plugin);
			else if (next.action === "load") loads.push(plugin);
		}
		const stop = (plugin: LunaPlugin) => plugin.stopRevoked().catch(plugin.trace.err.withContext("Failed to stop revoked plugin"));
		// Revoked plugins stop at once (a slow one doesn't hold the others up), except dependants of another one stopping: its unload unloads them
		// (they are marked after). A dependant two of them share is unloaded once, see unload
		const first = stops.filter((plugin) => !dependsOnAny(plugin, stops));
		await Promise.all(first.map(stop));
		for (const plugin of stops) if (!first.includes(plugin)) await stop(plugin);
		await Promise.all(
			loads.map((plugin) => {
				// A dependency that is not loaded yet (one in this list, or still revoked) loads it once it loads, as reloadAll leaves it
				const dependency = plugin.pendingDependencyOf(plugin);
				if (dependency !== undefined) {
					plugin.revoked._ = undefined;
					plugin.waitFor(dependency);
					return;
				}
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
				delete (value as any).package?.bomRawSha256;
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
		// A waiting update that is offered now (newly verified, or "Only verified updates" turned off) is announced
		const announce = () => Object.values(LunaPlugin.plugins).forEach((plugin) => plugin.announcePending());
		LunaRegistry.verified.onValue(announce);
		LunaRegistry.verifiedUpdatesOnly.onValue(announce);
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
			// Dont continue to loop if disabled or liveReload is false, or while the registry revokes the code: there is nothing to run.
			// A load that succeeds (the revocation lifted, a manual reload with new code) starts it again (see loadExports)
			if (!keepsLiveReloading({ enabled: this.enabled, liveReload: this._liveReload._, revoked: this.revoked._ !== undefined })) {
				this._reloadTimeout = undefined;
				return;
			}
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
		// The shim calls this right after it took this plugin's exports: their unload count then (see loadExports)
		plugin.importing?.set(this, this.unloadCount);
	}
	/** While this plugin's module is imported: the plugins it imports, with their unload count when it took their exports */
	private importing?: Map<LunaPlugin, number>;
	/** Counts this plugin's unloads, so a dependant can tell its dependency was unloaded while it was imported */
	private unloadCount = 0;
	/**
	 * This plugin (not loaded) waits for `dependency`, the one way every path does it: as its dependant, so its next load loads this plugin;
	 * the card says why unless it is merely on its way (enabled, no load error); and if it is loaded already (its dependants loop may have
	 * run before this plugin registered, or while this plugin wasn't enabled yet, see enable) this plugin loads again once the caller is done
	 */
	private waitFor(dependency: LunaPlugin) {
		dependency.addDependant(this);
		this.loadError._ = dependencyWaitMessage({
			name: dependency.name,
			revoked: dependency.revoked._ !== undefined,
			pending: dependency.enabled && dependency.installed !== false && dependency.loadError._ === undefined,
		});
		setTimeout(() => {
			if (dependency.exports === undefined || dependency.unloading !== undefined || this.exports !== undefined) return;
			this.load().catch(this.trace.err.withContext(`Failed to load after ${dependency.name} loaded`));
		});
	}
	/** The enabled plugin that an import failed to find in luna.core.modules (the build/index.ts shim's error), if any */
	private static missingDependencyOf(err: unknown): LunaPlugin | undefined {
		const name = /^Cannot find module (.+) in luna\.core\.modules$/.exec((<any>err)?.message ?? "")?.[1];
		const plugin = name === undefined ? undefined : LunaPlugin.getByName(name);
		// Loaded already is fine too (it loaded as this import failed): waitFor loads this plugin again then
		return plugin?.enabled && plugin.installed !== false ? plugin : undefined;
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
	private unloading?: Promise<void>;
	/**
	 * Unload this plugin and its dependants. Callers at the same time share one unload: two revoked plugins stopping at once
	 * (LunaPlugin.applyRevocations) can both reach a dependant they share, whose unloads must run once
	 */
	private unload(): Promise<void> {
		return (this.unloading ??= this.unloadOnce().finally(() => (this.unloading = undefined)));
	}
	private async unloadOnce(): Promise<void> {
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
			if (wasLoaded) {
				this.unloadCount++;
				this.trace.log("Unloaded");
			}
		}
	}
	/**
	 * Load the plugin if it is enabled
	 */
	public async load(): Promise<LunaPlugin> {
		if (this.enabled && this.installed !== false) await this.enable(true);
		return this;
	}
	// #endregion

	// #region enable/disable
	/** `queued`: from load(), which may have waited on the load semaphore while the plugin was disabled or uninstalled */
	public async enable(queued = false) {
		try {
			this.loading._ = true;
			await this.loadExports(undefined, undefined, !queued);
			// Turned off while queued (see loadExports): the user's choice stands
			if (queued && !this.wanted) return;
			this._enabled._ = true;
			// Loaded, or refused (revoked) or waiting for a dependency, not failed: the user's choice is stored (the setter skips it while there is
			// a load error), so the plugin loads once the revocation is lifted or the dependency loads, also after a restart
			this.store.enabled = true;
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
	 * @param beforeLoad Runs once the update passed the registry's checks, right before it is applied (the dialog's "Ask
	 * again" revokes there, so a refused update leaves the answers). If it throws, the update is not applied
	 */
	public async acceptUpdate(update: PluginPackage | undefined = this.pendingUpdate._, beforeLoad?: () => Promise<void>): Promise<void> {
		if (update?.code === undefined) return;
		// Hashed here from the code that would be stored, not taken from the package: any caller can hand one in
		const raw = await rawSha256(update.code);
		if (update.rawSha256 !== raw) update = { ...update, rawSha256: raw };
		const refusal = this.updateRefusal(update);
		if (refusal !== undefined) return this.refuseUpdate(update, refusal);
		await beforeLoad?.();
		this.trace.msg.log(`Updating ${this.name} ${this.package?.version ?? ""} -> ${update.version ?? ""}`);
		if (this.enabled) {
			await this.loadExports(true, update);
			// Turned off while it waited for the semaphore (loadExports returned before applying it): stored below without running, as for
			// a plugin that is off
			if (this.wanted || this.package?.hash === update.hash) {
				// Revoked while or just after it loaded: loadExports or stopRevoked said why and put the version the user had back
				if (this.revokedUpdate(update) === undefined) return;
				throw new Error(`Not updating ${this.name}: the Luna plugin registry revoked ${update.version ?? "this version"}`);
			}
		}
		const release = await this.loadSemaphore.obtain();
		try {
			// Checked again: the list may have changed while waiting for the semaphore
			const refusalNow = this.updateRefusal(update);
			if (refusalNow !== undefined) return this.refuseUpdate(update, refusalNow);
			this.applyUpdate(update);
		} finally {
			release();
		}
	}
	/** Why the user can't take this update now: the registry revoked it, or "Only verified updates" is on and the registry hasn't verified it */
	private updateRefusal(update: PluginPackage): string | undefined {
		const version = update.version ?? "this version";
		const revoked = this.revokedUpdate(update);
		if (revoked !== undefined) return `the Luna plugin registry revoked ${version}. ${describeRevoked(revoked)}`;
		if (!LunaRegistry.updateOffered(update.rawSha256, update.name ?? this.name))
			return `the Luna plugin registry hasn't verified ${version}, and only verified updates are on (Luna Settings > Plugins)`;
	}
	/** Say why the update is refused, and drop it if it is revoked (an unverified one stays shown). Throws */
	private refuseUpdate(update: PluginPackage, reason: string): never {
		if (this.pendingUpdate._?.hash === update.hash && this.revokedUpdate(update) !== undefined) this.pendingUpdate._ = undefined;
		return this.trace.msg.err.throw(`Not updating ${this.name}: ${reason}`);
	}
	/**
	 * Call while holding loadSemaphore.
	 * @returns The package it replaced, to put back if the update fails to load
	 */
	private applyUpdate(update: PluginPackage): PluginPackage | undefined {
		const previous = this.package;
		this.package = update;
		if (this.pendingUpdate._?.hash === update.hash) this.pendingUpdate._ = undefined;
		// Kept so a revocation of this update, whenever it arrives this session, puts the version the user had back (see restoreReplaced)
		this.replacedByUpdate = previous?.code !== undefined && update.rawSha256 !== undefined ? { rawSha256: update.rawSha256, previous } : undefined;
		return previous;
	}
	/** The registry's revocation of an update's code, if it is revoked (Luna's own plugins are never) */
	public revokedUpdate(update: PluginPackage): RevokedEntry | undefined {
		const decision = LunaRegistry.loadDecision({ url: this.url, rawSha256: update.rawSha256 });
		return decision.load ? undefined : decision.revoked;
	}
	/** Links to the source of an update and what it changes, for display (see helpers/pluginUpdates) */
	public static readonly updateLinks = updateLinks;
	/** The plugin's native permission answers that hold for all versions (see helpers/pluginUpdates) */
	public static readonly allowedForAllVersions = allowedForAllVersions;

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
		// Unloading this plugin unloaded its dependants too, and theirs: say why on their cards
		const seen = new Set<LunaPlugin>([this]);
		const mark = (plugin: LunaPlugin) => {
			for (const dependant of plugin.dependants) {
				if (seen.has(dependant)) continue;
				seen.add(dependant);
				// Only the ones down because of it (enabled, not loaded), and through them only: one that is off stops the chain
				if (dependant.exports !== undefined || !dependant.enabled || dependant.installed === false) continue;
				dependant.loadError._ = dependencyWaitMessage({ name: this.name, revoked: true, pending: false });
				mark(dependant);
			}
		};
		mark(this);
		// Once per revoked build: live reload calls loadExports every second, and each fetched revoked.json has new entry objects
		const sha = this.package?.rawSha256;
		if (this.revokedSha256 === sha && this.revoked._?.reason === entry.reason && this.revoked._?.report === entry.report) return;
		this.revokedSha256 = sha;
		this.revoked._ = entry;
		this.trace.msg.err(`${this.name} ${this.package?.version ?? ""} was not loaded: the Luna plugin registry revoked it. ${describeRevoked(entry)}`);
	}
	/** The update the user accepted last this session (its raw sha256) and the package it replaced. Not stored: after a restart the update just stops */
	private replacedByUpdate?: { rawSha256: string; previous: PluginPackage };
	/**
	 * Call holding loadSemaphore, with the revoked code unloaded. If that code is the update the user accepted last, store the version it replaced
	 * again. Returns whether it did: the caller loads it once the semaphore is released
	 */
	private restoreReplaced(): boolean {
		const current = this.package;
		const previous = versionToRestore(this.replacedByUpdate, current);
		if (current === undefined || previous === undefined) return false;
		this.replacedByUpdate = undefined;
		this.package = previous;
		// Loading it fetches the url again, which still serves the revoked update: already announced, and offered if the revocation is lifted
		this.refusedHash = current.hash;
		this.refusedUpdate = current;
		return true;
	}
	/**
	 * Load the version restoreReplaced put back. Not while a dependency isn't loaded (revoked too, or stopping): that one loads it once it loads,
	 * and until then the card says why it isn't running (the stored version is not the revoked one)
	 */
	private async loadRestored(): Promise<void> {
		const dependency = this.pendingDependencyOf(this);
		if (dependency !== undefined) {
			this.revoked._ = undefined;
			this.waitFor(dependency);
			return;
		}
		this.trace.log("Loading the version the revoked update replaced");
		return this.reload().catch(this.trace.err.withContext("Failed to load the previous version again"));
	}
	/** After loadExports found the code it was loading revoked (and unloaded): mark it, and put back the version a revoked accepted update replaced */
	private stopAsRevoked(entry: RevokedEntry) {
		this.markRevoked(entry);
		// Run it again once this load has released the semaphore
		if (this.restoreReplaced()) setTimeout(() => void this.loadRestored());
	}
	/**
	 * Unload this plugin because a newly accepted revoked.json revokes its code. It stays enabled: a version that isn't revoked loads again.
	 * If the code is an update the user accepted this session, the version it replaced is stored again and loaded
	 */
	private async stopRevoked(): Promise<void> {
		const release = await this.loadSemaphore.obtain();
		let restored = false;
		try {
			// Checked again: the code may have changed while waiting for the semaphore
			const decision = LunaRegistry.loadDecision({ url: this.url, rawSha256: packageSha256s(this.package) });
			if (decision.load) return;
			// Already unloaded: by a revoked dependency's unload (marked here all the same), or disabled meanwhile (nothing to do)
			if (this.exports === undefined && !(this.enabled && this.installed !== false)) return;
			if (this.exports !== undefined) await this.unload();
			this.markRevoked(decision.revoked);
			restored = this.restoreReplaced();
		} finally {
			release();
		}
		if (restored) await this.loadRestored();
	}
	// #endregion

	// #region install/uninstall
	public async install() {
		this.loading._ = true;
		// A version replaced before an uninstall is not put back after a reinstall
		this.replacedByUpdate = undefined;
		// Uninstall can leave the old package, code included, in storage: install what the url serves now instead of offering it as an update
		if (!this.installed && this.store.package?.code !== undefined)
			this.store.package = { ...this.store.package, code: undefined, codeSha256: undefined, rawSha256: undefined, bomRawSha256: undefined };

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
		this.replacedByUpdate = undefined;
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
		// Announced again if its revocation is lifted
		this.announcedHash = undefined;
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
		this.announcePending();
	}
	/** The pending update announced last, so each is announced once */
	private announcedHash?: string;
	/** Say that the pending update waits for the user, once, as soon as it is offered (verified, or "Only verified updates" off) */
	private announcePending() {
		const pending = this.pendingUpdate._;
		if (pending === undefined || this.announcedHash === pending.hash || !LunaRegistry.updateOffered(pending.rawSha256, pending.name ?? this.name)) return;
		this.announcedHash = pending.hash;
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
			// Exact code has one key; the json can't set it
			newPackage.bomRawSha256 = undefined;

			// Ensure that code is fetched if its changed or undefined
			if (newPackage.code === undefined) newPackage.code = `${await LunaPlugin.fetchCode(this.url)}\n//# sourceURL=${this.url}.mjs`;
			newPackage.exactCode = true;
			// Hashed here too, not only in loadExports: a loaded plugin whose code didn't change returns early there and must keep its registry key
			newPackage.rawSha256 ??= await rawSha256(newPackage.code);
			newPackage.codeSha256 ??= await sha256Hex(codeToImport(newPackage.code, this.url));
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
					this.announcePending();
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
	/** Whether the user still wants this plugin running (enabled and installed) */
	private get wanted(): boolean {
		return this.enabled && this.installed !== false;
	}
	/**
	 * `enabling`: the user turning the plugin on (enable(), before it counts as enabled). Every other load is for a plugin that is on
	 * (load(), reload, an accepted update, live reload, a lifted revocation, a restore) and may wait on the semaphore and fetch while the
	 * user disables or uninstalls it (they don't wait for loads): it stops wherever it finds that, and unloads if it got as far as importing
	 */
	private async loadExports(reload?: true, update?: PluginPackage, enabling?: boolean): Promise<void> {
		// Ensure we cant start loading midway through loading
		const release = await this.loadSemaphore.obtain();
		const unwanted = () => !enabling && !this.wanted;
		if (unwanted()) {
			release();
			return;
		}
		// The lists or the setting may have changed while waiting for the semaphore: a refused update replaces nothing and the running version keeps running
		const refusal = update !== undefined ? this.updateRefusal(update) : undefined;
		if (refusal !== undefined) {
			release();
			return this.refuseUpdate(update!, refusal);
		}
		let replaced: { previous: PluginPackage | undefined } | undefined;
		try {
			if (update !== undefined) replaced = { previous: this.applyUpdate(update) };
			// If code hasnt changed and we have already loaded exports we are done
			const codeChanged = await this.fetchPackage();
			if (unwanted()) return;
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
			// Code stored before exact fetching (kept while an update waits) may have lost a leading BOM: its other possible key too
			const [sha256, raw, bomRaw] = await Promise.all([
				sha256Hex(code),
				rawSha256(this.code),
				this.package!.exactCode ? undefined : legacyBomSha256(this.code),
			]);
			const pkg = this.package!;
			if (pkg.codeSha256 !== sha256 || pkg.rawSha256 !== raw || pkg.bomRawSha256 !== bomRaw)
				this.package = { ...pkg, codeSha256: sha256, rawSha256: raw, bomRawSha256: bomRaw };
			const keys = packageSha256s(this.package);

			// Code the registry revoked doesn't run (the list in use, see LunaRegistry for startup order)
			const decision = LunaRegistry.loadDecision({ url: this.url, rawSha256: keys });
			if (!decision.load) return this.stopAsRevoked(decision.revoked);
			this.revoked._ = undefined;

			const blobURL = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
			// The plugins this code imports: one unloaded after this import took its exports (revoked, disabled or reloading) found no
			// exports here to unload, see below
			const imported = (this.importing = new Map());
			try {
				this.exports = await import(blobURL);
			} finally {
				this.importing = undefined;
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

			// Turned off during the import: its unload found no exports to unload, so unload here (before the dependants loop below loads any)
			if (unwanted()) {
				await this.unload();
				return;
			}
			// A revoked.json accepted during the import: applyRevocations skipped this plugin (no exports yet), so it is stopped here,
			// once its unloads are known
			const late = LunaRegistry.loadDecision({ url: this.url, rawSha256: keys });
			if (!late.load) {
				await this.unload();
				return this.stopAsRevoked(late.revoked);
			}
			// The one check for a dependency that changed while this plugin loaded (revoked, disabled, reloaded or still unloading after the
			// import took its exports, see changedDependency): running now would keep the exports it unloaded. This plugin is in its dependants
			// since the import, so it loads this plugin once it loads again (see waitFor for one loaded already)
			const dependency = changedDependency(imported, (plugin) => ({
				unloadCount: plugin.unloadCount,
				unloading: plugin.unloading !== undefined,
				loaded: plugin.exports !== undefined,
			}));
			if (dependency !== undefined) {
				await this.unload();
				this.waitFor(dependency);
				this.trace.log(`Unloaded again: ${dependency.name} changed while this plugin loaded`);
				return;
			}

			this.trace.log("Loaded");
			// Live reload stops while the code is revoked (see startReloadLoop): running code resumes it
			if (this.enabled && this._liveReload._) this.startReloadLoop();
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
			// Ensure we arnt partially loaded
			const missing = LunaPlugin.missingDependencyOf(err);
			if (missing !== undefined) {
				// A dependency that stopped (revoked, disabled or reloading) before this import reached it: not a failure, this plugin waits for
				// it as a changed dependency does above (an accepted update stays accepted and loads with it)
				await this.unload();
				this.waitFor(missing);
				this.trace.log(`Waiting for ${missing.name}, which is not loaded`);
				return;
			}
			// Set loadError for anyone listening
			this.loadError._ = (<any>err)?.message ?? err?.toString();
			// Notify users
			this.trace.msg.err.withContext(`Failed to load`)(err);
			await this.unload();
			// An accepted update that fails to load waits again, the version the user had is the one stored (and runs on the next load)
			if (replaced !== undefined && update !== undefined && this.package?.hash === update.hash) {
				if (replaced.previous !== undefined) this.package = replaced.previous;
				this.replacedByUpdate = undefined;
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
