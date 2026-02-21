import { ReactiveStore } from "./ReactiveStore";
import { LunaPlugin } from "./LunaPlugin";

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

	public static async restore(data: ExportData)
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

		return true;
	}
}
