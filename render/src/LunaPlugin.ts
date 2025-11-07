// Ensure that @triton/lib is loaded onto window for plugins to use shared memory space
import { Semaphore, Signal } from "@inrixia/helpers";
import { unloadSet, type LunaUnloads } from "./helpers/unloadSet";
import { ReactiveStore } from "./ReactiveStore";

import { type LunaUnload } from "@luna/core";
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
	dependencies?: string[];
	devDependencies?: string[];
	code?: string;
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

	// Storage backing for persisting plugin url/enabled/code etc... See LunaPluginStorage
	public static readonly pluginStorage: ReactiveStore = ReactiveStore.getStore("@luna/plugins");
	// Static store for all loaded plugins so we dont double load any
	public static readonly plugins: Record<string, LunaPlugin> = {};

	// Static list of Luna plugins that should be seperate from user plugins
	public static readonly corePlugins: Set<string> = new Set(["@luna/lib", "@luna/lib.native", "@luna/ui", "@luna/dev"]);

	static {
		// Ensure all plugins are unloaded on beforeunload
		addEventListener("beforeunload", () => {
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
			const plugin = LunaPlugin.plugins[pluginName];
			const dependantPlugin = LunaPlugin.plugins[dependantName];
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
		let name = storeInit.package?.name;
		if (name === undefined) {
			// Ensure the url is sanitized incase users paste a link to the actual file
			storeInit.url = storeInit.url.replace(/(\.mjs|\.json|\.mjs.map)$/, "");

			storeInit.package ??= await this.fetchPackage(storeInit.url);
			name = storeInit.package.name;
		}

		if (name in this.plugins) return this.plugins[name];

		// Disable liveReload on load so people dont accidentally leave it on
		storeInit.liveReload = false;

		const store = await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>(name);
		Object.assign(store, storeInit);

		const plugin = (this.plugins[name] ??= new this(name, store));
		return plugin.load();
	}

	public static async fromName(name: string): Promise<LunaPlugin | undefined> {
		if (name in this.plugins) return this.plugins[name];

		const store = await LunaPlugin.pluginStorage.getReactive<LunaPluginStorage>(name);
		if (store === undefined) return;

		return this.fromStorage(store);
	}

	public static async loadStoredPlugins() {
		const keys = await LunaPlugin.pluginStorage.keys();
		return Promise.all(keys.map(async (name) => LunaPlugin.fromName(name).catch(this.trace.err.withContext("loadStoredPlugins", name))));
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
		this.trace = LunaPlugin.trace.withSource(`[${this.name}]`).trace;
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
	// #endregion

	// #region load/unload
	/**
	 * Are you sure you didnt mean disable() or reload()?
	 * This will unload the plugin without disabling it!
	 */
	private async unload(): Promise<void> {
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

	// #region install/uninstall
	public async install() {
		this.loading._ = true;
		this.store.installed = true;
		await this.enable();
		coreTrace.msg.log(`Installed plugin ${this.name}`);
	}
	public async uninstall() {
		await this.disable();
		this.loading._ = true;
		for (const name in LunaPlugin.plugins) {
			// Just to be safe
			LunaPlugin.plugins[name].dependants.delete(this);
		}
		this.store.installed = false;
		delete LunaPlugin.plugins[this.name];
		await LunaPlugin.pluginStorage.del(this.name);
		this.loading._ = false;
		coreTrace.msg.log(`Uninstalled plugin ${this.name}`);
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

			// If hash hasnt changed then just reuse stored code
			const codeChanged = this.package?.hash !== newPackage.hash;
			// If code hasnt changed then just reuse stored code
			if (!codeChanged) newPackage.code = this.package?.code;

			this.package = newPackage;

			// Ensure that code is fetched if its changed or undefined
			this.package.code ??= `${await LunaPlugin.fetchCode(this.url)}\n//# sourceURL=${this.url}.mjs`;

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

			const blobURL = URL.createObjectURL(new Blob([this.code], { type: "text/javascript" }));
			this.exports = await import(blobURL);
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

			this.trace.log(`Loaded`);
			// Make sure we load any enabled dependants, this is mostly to facilitate live reloading dependency trees
			for (const dependant of this.dependants) {
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
