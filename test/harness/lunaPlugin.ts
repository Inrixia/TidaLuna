import { ReactiveStore } from "../../render/src/ReactiveStore";
import type { LunaPluginStorage } from "../../render/src/LunaPlugin";

/**
 * Stand-in for render/src/LunaPlugin.ts, which fetches, imports plugin bundles from blobs and talks over IPC.
 * Only what other modules and the tests touch: the plugin storage, the core plugin list and plugin install/fetch hooks.
 */
export class LunaPlugin {
	/** Same store the real class uses, so SettingsTransfer dumps and restores through it */
	public static pluginStorage = ReactiveStore.getStore("@luna/plugins");

	/** Core plugins can't be disabled or removed */
	public static corePlugins = new Set(["@luna/lib", "@luna/lib.native", "@luna/ui", "@luna/dev", "@luna/linux"]);

	/** Installed/known plugins by url */
	public static plugins: Record<string, LunaPlugin> = {};

	public readonly url: string;
	public installed: boolean;
	public enabled: boolean;
	public package?: LunaPluginStorage["package"];

	public constructor(url: string, installed = true, enabled = true) {
		this.url = url;
		this.installed = installed;
		this.enabled = enabled;
	}

	/** Reset the fakes between tests */
	public static reset() {
		LunaPlugin.plugins = {};
		LunaPlugin.fetchedPackages = {};
	}

	/**
	 * Fetch hooks the tests own: `fromStorage` returns the plugin registered under the url (creating an
	 * uninstalled one if `installOnFirstUse`), `fetchPackage` reads `LunaPlugin.fetchedPackages`.
	 */
	public static fetchedPackages: Record<string, LunaPluginStorage["package"]> = {};

	public static async fromStorage({ url, installed = false, enabled = true }: { url: string; installed?: boolean; enabled?: boolean; package?: any } = {} as any) {
		const existing = LunaPlugin.plugins[url];
		if (existing !== undefined) return existing;
		const plugin = new LunaPlugin(url, installed, enabled);
		LunaPlugin.plugins[url] = plugin;
		return plugin;
	}

	public static async loadStoredPlugins() {}

	public static getByName(url: string) {
		return LunaPlugin.plugins[url];
	}

	public static addDependant() {}

	public static storePluginUrl(storeUrl: string, file: string) {
		return `${storeUrl.replace(/\/$/, "")}/${file}`;
	}

	public static async fetchPackage(url: string) {
		const pkg = LunaPlugin.fetchedPackages[url];
		if (pkg === undefined) throw new Error(`No package for ${url}`);
		return pkg;
	}

	public async install() {
		this.installed = true;
	}

	/** Storage as the real class dumps it: every stored plugin, without its code when `stripCode` */
	public static async dumpStorage(stripCode = true): Promise<Record<string, unknown>> {
		const dumped: Record<string, unknown> = {};
		for (const key of await LunaPlugin.pluginStorage.keys()) {
			const value = await LunaPlugin.pluginStorage.get<LunaPluginStorage>(key);
			if (value === undefined) continue;
			if (stripCode && typeof value === "object" && value !== null && "code" in value) {
				const { code: _code, ...rest } = value as Record<string, unknown>;
				dumped[key] = rest;
				continue;
			}
			dumped[key] = value;
		}
		return dumped;
	}
}
