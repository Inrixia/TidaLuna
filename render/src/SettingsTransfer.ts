import { ReactiveStore } from "./ReactiveStore";
import { LunaPlugin, type LunaPluginStorage } from "./LunaPlugin";

export interface ExportData
{
	version: 1; //future proofing -> if anything changes we want the ability to load old exports correctly
	timestamp: string;
	stores: Record<string, Record<string, unknown>>;
	featureFlags: Record<string, boolean> | null;
}

export class SettingsTransfer
{
	//new stores to be added here
	private static readonly exportableStores: ReactiveStore[] =
	[
		ReactiveStore.getStore("@luna/pluginStorage"),
		LunaPlugin.pluginStorage, //@luna/plugins
		ReactiveStore.getStore("@luna/storage"),
	];

	public static async dump(stripCode: boolean = true, featureFlags: Record<string, boolean> | null = null): Promise<ExportData>
	{
		const stores: Record<string, Record<string, unknown>> = {};
		for (const store of this.exportableStores)
		{
			if (store === LunaPlugin.pluginStorage)
				stores[store.idbName] = await LunaPlugin.dumpStorage(stripCode);
			else
				stores[store.idbName] = await store.dump();
		}

		return {
			version: 1,
			timestamp: new Date().toISOString(),
			stores,
			featureFlags,
		};
	}

	/**
	 * Writes the exported stores back. The installed plugins live in Luna core, not in the page's storage: the
	 * exported ones are installed through it (it asks the user for each, in its own window) and the others uninstalled.
	 * @returns The plugins that were not installed (cancelled, or the core could not ask)
	 */
	public static async restore(data: ExportData): Promise<string[]>
	{
		for (const store of this.exportableStores)
		{
			const storeData = data.stores[store.idbName];
			if (!storeData)
				continue;

			await store.clear();

			for (const [key, value] of Object.entries(storeData))
				await store.set(key, value);
		}

		const plugins = data.stores[LunaPlugin.pluginStorage.idbName];
		if (!plugins)
			return [];
		const wanted = new Map<string, { name: string; enabled: boolean }>();
		for (const [key, value] of Object.entries(plugins))
		{
			const entry = value as Partial<LunaPluginStorage> | null;
			if (entry?.installed !== true || typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url) || LunaPlugin.corePlugins.has(key))
				continue;
			wanted.set(entry.url, { name: typeof entry.package?.name === "string" ? entry.package.name : key, enabled: entry.enabled !== false });
		}

		await LunaPlugin.migrateToCore();
		for (const { url } of await __LunaCore.list())
			if (!wanted.has(url))
				await __LunaCore.uninstall(url);

		const notInstalled: string[] = [];
		for (const [url, { name, enabled }] of wanted)
		{
			try
			{
				// Exported disabled and already installed: installing would enable it (and ask) only to disable it again
				if (!enabled && (await __LunaCore.info(url)) !== undefined)
				{
					await __LunaCore.disable(url);
					continue;
				}
				// One window at a time: the user's answer lets the next one open (see confirmGate)
				if (!(await __LunaCore.install(url)))
				{
					notInstalled.push(name);
					continue;
				}
				if (!enabled)
					await __LunaCore.disable(url);
			}
			catch (err)
			{
				console.warn(`[Luna] Failed to install ${name} from the imported settings`, err);
				notInstalled.push(name);
			}
		}
		return notInstalled;
	}

	public static validate(data: unknown): data is ExportData
	{
		if (typeof data !== "object" || data === null)
			return false;

		const obj = data as Record<string, unknown>;
		if (obj.version !== 1)
			return false;

		if (typeof obj.stores !== "object" || obj.stores === null)
			return false;

		// restore() clears each store before writing, so reject anything it can't write back
		for (const store of Object.values(obj.stores))
			if (typeof store !== "object" || store === null || Array.isArray(store))
				return false;

		return true;
	}
}
