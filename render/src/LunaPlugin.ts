// Ensure that @triton/lib is loaded onto window for plugins to use shared memory space
import { Semaphore, Signal } from "@inrixia/helpers";
import { unloadSet, type LunaUnloads } from "./helpers/unloadSet";
import { ReactiveStore } from "./ReactiveStore";
import { store as obyStore } from "oby";

import { type LunaUnload } from "@luna/core";
import { notAskedMessage } from "../../native/core/notAsked";
import { isCoreUrl, isDevUrl } from "../../native/core/policy";
import type { CorePluginInfo, PendingUpdate } from "../../native/core/registry";
import * as ftch from "./helpers/fetch";
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
	/** Entry of the plugin's isolated world, built to `<plugin>.world.json` (see build/plugins/lunaWorldPlugin.ts) */
	lunaWorld?: string;
	/** sha256 of `<plugin>.world.json`, so a change to the world alone is a new version */
	worldHash?: string;
	code?: string;
	/**
	 * sha256 (hex) of the code Luna runs, set by Luna core (native/core/registry.ts).
	 * To reproduce it: take the served `<url>.mjs` text, append `\n//# sourceURL=<url>.mjs`, and sha256 the result as UTF-8.
	 * A plugin moved to another url with the same code keeps the url it was accepted from in that line until an update.
	 */
	codeSha256?: string;
};

// Trust decisions (install, enable, which code runs, updates, natives) are made by Luna core in the main process, see
// native/core/coreWorld.ts. This class runs the code the core hands over and keeps the page-side state for the UI.
export type { CorePluginInfo, PendingUpdate };

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
		// A plugin only named like one of Luna's own never touches that plugin's stored copy (stored by name)
		if (LunaPlugin.corePlugins.has(name) && !isCoreUrl(storeInit.url)) {
			const plugin = (this.plugins[storeInit.url] ??= new this(name, createNonPersistedStore()));
			return plugin.load();
		}
		// Get persisted store to check if this URL matches
		const persistedStore = await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>(name);
		// Luna's own plugin takes back its stored copy from a plugin only named like it (stored before, or imported)
		const coreReclaims = isCoreUrl(storeInit.url) && (typeof persistedStore.url !== "string" || !isCoreUrl(persistedStore.url));
		if (persistedStore.url === undefined || persistedStore.url === storeInit.url || coreReclaims) {
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
		await this.migrateToCore();
		// Luna core holds what is installed: its record moves (other code at the new url waits as an update), the page's copy follows
		for (const { url, name } of await __LunaCore.list()) {
			if (!url.toLowerCase().startsWith(fromPrefix)) continue;
			const newUrl = `${toBaseUrl}/${url.slice(fromPrefix.length)}`;
			try {
				await __LunaCore.moveUrl(url, newUrl);
			} catch (err) {
				this.trace.msg.err.withContext(`Failed to move plugin ${name} to ${newUrl}`)(err);
				continue;
			}
			// Re-key loaded plugin so it isnt duplicated <3
			const plugin = this.plugins[url];
			if (plugin !== undefined) {
				delete this.plugins[url];
				this.plugins[newUrl] = plugin;
			}
			this.trace.log(`Migrating plugin ${name} from ${url} to ${newUrl}`);
			const store = await this.pluginStorage.getReactive<LunaPluginStorage>(name);
			if (store.url === url) store.url = newUrl;
			if (plugin !== undefined && plugin.store.url === url) plugin.store.url = newUrl;
		}
	}

	private static migrated?: Promise<void>;
	/** The first start with Luna core hands over what the page had stored (native plugins then wait for the user) */
	public static migrateToCore(): Promise<void> {
		return (this.migrated ??= (async () => {
			if (!(await __LunaCore.needsMigration())) return;
			const stored = await LunaPlugin.pluginStorage.dump();
			const entries = Object.entries(stored).flatMap(([key, value]: [string, any]) =>
				value?.installed && typeof value.url === "string"
					? [
							{
								url: value.url,
								name: typeof value.package?.name === "string" ? value.package.name : key,
								enabled: value.enabled === true,
							},
						]
					: [],
			);
			await __LunaCore.migrate(entries);
		})().catch((err) => {
			// Tried again by the next caller
			this.migrated = undefined;
			throw err;
		}));
	}

	public static async loadStoredPlugins() {
		await this.migrateToCore();
		// What is installed comes from Luna core, not from the page's storage (page code can write that)
		const installed = await __LunaCore.list();
		return Promise.all(
			installed.map(async ({ url, name }) => {
				// The page's copy of the package is kept for display (description, author), its code never runs (see fetchPackage)
				const stored = await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>(name);
				const pkg = stored.url === url && stored.package?.name === name ? stored.package : ({ name } as PluginPackage);
				return LunaPlugin.fromStorage({ url, package: pkg }).catch(this.trace.err.withContext("loadStoredPlugins", name));
			}),
		);
	}

	/**
	 * Reload every installed and enabled plugin, except core plugins, one at a time.
	 * A plugin that depends on another plugin being reloaded is skipped, reloading that plugin reloads its dependants.
	 * @returns The plugins that failed to reload (each one also reports its own error), including dependants of a failed plugin, which are left unloaded
	 */
	public static async reloadAll(): Promise<LunaPlugin[]> {
		const plugins = Object.values(LunaPlugin.plugins).filter((plugin) => plugin.installed && plugin.enabled && !plugin.isCore);
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
	public static async dumpStorage(stripCode: boolean = true): Promise<Record<string, unknown>> {
		const data = await this.pluginStorage.dump();
		if (!stripCode) return data;

		const stripped = structuredClone(data);
		for (const value of Object.values(stripped)) {
			if (value && typeof value === "object") delete (value as any).package?.code;
		}

		return stripped;
	}
	// #endregion

	// #region Tracer
	public static readonly trace: Tracer = coreTrace.withSource(".LunaPlugin").trace;
	public readonly trace: Tracer;
	// #endregion

	// #region constructor
	private constructor(
		public readonly name: string,
		public readonly store: LunaPluginStorage,
	) {
		const devSuffix = isDevUrl(this.store.url) ? " [DEV]" : "";
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
	 * Plugin code runs from a blob with `//# sourceURL=<url>.mjs`, so its frames carry that url: the one in its code's last
	 * line, which after a move with the same code still names the url the code was accepted from.
	 */
	public static fromStack(stack?: string): LunaPlugin | undefined {
		if (stack === undefined) return undefined;
		const plugins = Object.values(LunaPlugin.plugins)
			.filter((plugin) => !plugin.isCore && plugin.url.length > 0)
			.map((plugin) => ({ plugin, name: plugin.sourceName, own: `${plugin.url}.mjs` }));
		/** The longest name in the frame (`https://s/p.mjs.mjs` over `https://s/p.mjs`), then the one at its own url */
		const best = (names: { name: string; own: string; plugin: LunaPlugin }[]) =>
			names.reduce<(typeof names)[number] | undefined>(
				(a, b) =>
					a === undefined || b.name.length > a.name.length || (b.name.length === a.name.length && b.name === b.own && a.name !== a.own) ? b : a,
				undefined,
			)?.plugin;
		for (const frame of stack.split("\n")) {
			// The plugin whose code names this frame's url (of two that do, one moved off a url and one installed there
			// since, the one at that url), else one at the url
			const plugin =
				best(plugins.filter(({ name }) => frame.includes(name))) ??
				best(plugins.filter(({ own }) => frame.includes(own)).map((entry) => ({ ...entry, name: entry.own })));
			if (plugin !== undefined) return plugin;
		}
		return undefined;
	}

	/** The name the plugin's frames carry: the url in its code's `//# sourceURL=` line (its last), else `<url>.mjs` */
	private get sourceName(): string {
		const code = this.code ?? "";
		const marker = "\n//# sourceURL=";
		const at = code.lastIndexOf(marker);
		const name = at === -1 ? "" : code.slice(at + marker.length);
		return name.length > 0 && !/[\n\r\u2028\u2029]/.test(name) ? name : `${this.url}.mjs`;
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
	/** One of Luna's own plugins: served from its bundle (`https://luna/`), not just named like one */
	public get isCore(): boolean {
		return isCoreUrl(this.url) && LunaPlugin.corePlugins.has(this.name);
	}
	/** Named like one of Luna's own plugins but served from elsewhere: it has no stored copy, that name's belongs to Luna's */
	private get namedLikeCore(): boolean {
		return LunaPlugin.corePlugins.has(this.name) && !isCoreUrl(this.url);
	}
	public get isDev(): boolean {
		return isDevUrl(this.url);
	}
	// #endregion

	// #region load/unload
	/** The plugin's world (see native/core/coreWorld.ts) is loaded */
	private worldLoaded = false;
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
			// Always, even if a dependant failed to unload: a plugin that isn't loaded must not keep its world's natives callable
			if (this.worldLoaded) {
				this.worldLoaded = false;
				await __LunaCore.unloadWorld(this.url).catch(this.trace.err.withContext("Failed to unload its world"));
			}
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
		const isCore = isCoreUrl(this.url);
		const info = isCore ? undefined : await __LunaCore.info(this.url);
		if (!isCore) {
			// The page's copy only mirrors Luna core's state, for the UI
			this.store.installed = info !== undefined;
			this._enabled._ = info?.enabled === true;
			this.setPendingUpdate(info?.pending);
		}
		if (isCore ? this.enabled : info?.enabled) await this.loadEnabled();
		return this;
	}
	// #endregion

	/**
	 * Runs a core request that may ask the user. If the core did not ask (TIDAL not in use, too many requests, a cool-down
	 * after cancels), says why instead of doing nothing: counts as not allowed
	 */
	private async askCore(request: () => Promise<boolean>): Promise<boolean> {
		try {
			return await request();
		} catch (err) {
			const message = notAskedMessage(err);
			if (message === undefined) throw err;
			this.trace.msg.warn(message);
			return false;
		}
	}

	// #region enable/disable
	/** Asks Luna core, which asks the user before enabling native code */
	public async enable() {
		if (!(await this.askCore(() => __LunaCore.enable(this.url)))) {
			// Not installed or not allowed by the user
			this._enabled._ = false;
			return;
		}
		await this.loadEnabled();
	}
	private async loadEnabled() {
		try {
			this.loading._ = true;
			await this.loadExports();
			if (!isCoreUrl(this.url)) {
				// The switch shows Luna core's state: it may have refused to run the plugin (a migrated native plugin waits
				// until the user enables it again, which shows them its native code)
				const info = await __LunaCore.info(this.url);
				this.store.installed = info !== undefined;
				this.setPendingUpdate(info?.pending);
				if (info?.enabled !== true) {
					this._enabled._ = false;
					if (this.coreRefusal !== undefined) this.trace.msg.warn(this.coreRefusal);
					return;
				}
			}
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
		// Unload first: its unloads may still call its natives, which the core refuses once it is disabled
		try {
			await this.unload();
		} finally {
			// Even if its unloads throw: the user disabled it
			await __LunaCore.disable(this.url);
			this._enabled._ = false;
			this.loadError._ = undefined;
		}
	}
	public async reload() {
		// LoadExports will handle unloading etc and ensure code is live
		await this.loadExports(true);
	}
	// #endregion

	// #region updates
	/**
	 * An update the url serves that the user has not accepted yet: its version, code sha256 and native files, and which
	 * native files it adds or removes. The accepted version keeps running until acceptUpdate. Found each time the plugin
	 * loads (client start, reload).
	 */
	public readonly pendingUpdate: Signal<PendingUpdate | undefined> = new Signal(undefined);
	private setPendingUpdate(update: PendingUpdate | undefined) {
		// The same update found again keeps its object. Other code under the same package hash is another update
		const current = this.pendingUpdate._;
		if (update?.hash === current?.hash && update?.codeSha256 === current?.codeSha256 && update?.worldHash === current?.worldHash) return;
		this.pendingUpdate._ = update;
		if (update !== undefined) LunaPlugin.announceUpdate(this.name);
	}
	/**
	 * Luna core shows the update to the user in its own window and runs it once they accept; a call from page code alone
	 * accepts nothing. The update is the one the core has waiting: if the url served a newer one since, that one is shown.
	 * @returns Whether the user accepted it
	 */
	public async acceptUpdate(): Promise<boolean> {
		if (this.pendingUpdate._ === undefined) return false;
		if (!(await this.askCore(() => __LunaCore.acceptUpdate(this.url)))) return false;
		this.trace.msg.log(`Updating ${this.name} ${this.package?.version ?? ""} -> ${this.pendingUpdate._?.version ?? ""}`);
		this.pendingUpdate._ = undefined;
		if (this.enabled) await this.loadExports(true);
		return true;
	}

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

	// #region install/uninstall
	public async install() {
		// Luna core asks the user, in its own window
		if (!(await this.askCore(() => __LunaCore.install(this.url)))) return;
		this.loading._ = true;

		// Uninstall other versions of the same plugin (e.g., switching from GitHub to DEV)
		const otherVersions = LunaPlugin.getAllByName(this.name).filter((p) => p !== this && p.installed && !p.isCore);
		for (const other of otherVersions) {
			coreTrace.msg.log(`Switching plugin ${this.name} from ${other.url} to ${this.url}`);
			await other.uninstall();
		}

		// Update persisted store with this plugin's URL so it loads on restart (not a lookalike of Luna's own: see fromStorage)
		if (!this.namedLikeCore) {
			const persistedStore = await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>(this.name);
			persistedStore.url = this.url;
			persistedStore.package = this.store.package;
			persistedStore.installed = true;
			persistedStore.enabled = true;
		}

		this.store.installed = true;
		await this.loadEnabled();
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
		if (!this.namedLikeCore) await LunaPlugin.pluginStorage.forget(this.name);
		// Luna core also forgets its native permissions, so a reinstall asks again
		await __LunaCore.uninstall(this.url).catch(this.trace.err.withContext("Failed to uninstall in Luna core"));
		this.loading._ = false;
		coreTrace.msg.log(`Uninstalled plugin ${this.name}${this.isDev ? " [DEV]" : ""}`);
	}
	// #endregion

	// #region Fetch
	/**
	 * Gets the code to run from Luna core: the version the user accepted (Luna's own plugins: what its bundle serves).
	 * Returns true if code changed, should never be called outside of loadExports
	 */
	private coreRefusal?: string;
	private async fetchPackage(): Promise<boolean> {
		try {
			this.fetching._ = true;
			this.coreRefusal = undefined;
			const { package: newPackage, code, pending } = await __LunaCore.load(this.url);
			const codeChanged = this.package?.hash !== newPackage.hash || this.package?.worldHash !== newPackage.worldHash || this.code !== code;
			this.package = { ...newPackage, code };
			this.setPendingUpdate(pending);
			return codeChanged;
		} catch (err) {
			// The core runs nothing it hasn't got: the page's copy of the code must not run instead
			this.coreRefusal = `Failed to get code from Luna core: ${(err as Error)?.message ?? err}`;
			this.trace.warn(this.coreRefusal);
			if (this.package !== undefined) this.package = { ...this.package, code: undefined };
		} finally {
			this.fetching._ = false;
		}
		return false;
	}
	// #endregion

	// #region Load
	private readonly loadSemaphore: Semaphore = new Semaphore(1);
	private async loadExports(reload?: true): Promise<void> {
		// Ensure we cant start loading midway through loading
		const release = await this.loadSemaphore.obtain();
		try {
			// If code hasnt changed and we have already loaded exports we are done
			const codeChanged = await this.fetchPackage();
			if (!reload && !codeChanged && this.exports !== undefined) return;

			// If code failed to fetch then nothing we can do
			if (this.code === undefined) return;
			this.loading._ = true;

			// Ensure we unload if previously loaded
			await this.unload();

			const code = this.code;
			const blobURL = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
			try {
				this.exports = await import(blobURL);
			} finally {
				// The imported module stays alive; the blob would otherwise keep a copy of the code per load
				URL.revokeObjectURL(blobURL);
			}
			if (this.exports === undefined) return this.trace.err.throw(`Failed to load. Module exports undefined!`);

			// Its world holds the code that calls its natives: Luna core runs the version the user accepted
			if (typeof this.package?.lunaWorld === "string") {
				this.worldLoaded = true;
				await __LunaCore.loadWorld(this.url);
			}

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
			// For sanity throw the error just to be safe
			throw err;
		} finally {
			release();
			this.loading._ = false;
		}
	}
	// #endregion
}
