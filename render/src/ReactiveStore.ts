import type { AnyRecord, MaybePromise } from "@inrixia/helpers";
import { createStore as createIdbStore, del as idbDel, get as idbGet, keys as idbKeys, set as idbSet, type UseStore } from "idb-keyval";
import { store as obyStore } from "oby";
import { coreTrace, type Tracer } from "./trace";

type StoreReconcileable = AnyRecord | any[];

export class ReactiveStore {
	public static Storages: Record<string, ReactiveStore> = {};
	public static async getPluginStorage<T extends AnyRecord>(pluginName: string, defaultValue?: T) {
		const pluginStore = this.getStore(`@luna/pluginStorage`);
		const storage = await pluginStore.getReactive<T>(pluginName);
		if (defaultValue !== undefined) Object.keys(defaultValue).forEach((key) => (storage[key as keyof T] ??= defaultValue[key]));
		return storage;
	}
	public static getStore(name: string): ReactiveStore {
		return (this.Storages[name] ??= new this(name));
	}

	public readonly idbStore: UseStore;
	public readonly trace: Tracer;
	private constructor(public readonly idbName: string) {
		this.trace = coreTrace.withSource(`.ReactiveStore[${idbName}]`).trace;
		this.idbStore = createIdbStore(idbName, "_");
	}

	private readonly reactiveCache: Record<string, any> = {};
	public async getReactive<T extends StoreReconcileable>(key: string, defaultValue: T = <T>{}): Promise<T> {
		if (key in this.reactiveCache) return this.reactiveCache[key];
		// Callers that arrive while the first is still reading idb share its object, or each would get its own and only the last would be cached
		return (this.reactiveLoading[key] ??= this.loadReactive(key, defaultValue).finally(() => delete this.reactiveLoading[key]));
	}
	private readonly reactiveLoading: Record<string, Promise<any>> = {};
	/** Stops the write listener for a key, so a change made before `delete` cannot queue a write after it */
	private readonly unloads: Record<string, () => void> = {};
	/** The write a key's listener last queued, which `delete` waits for so it lands before the delete rather than after */
	private readonly pendingWrites: Record<string, Promise<void>> = {};
	private async loadReactive<T extends StoreReconcileable>(key: string, defaultValue: T): Promise<T> {
		// Create the oby reactive object
		const reactiveObj = obyStore(defaultValue);
		// Reconcile the object with the idb store to ensure we have the latest values
		obyStore.reconcile(reactiveObj, (await idbGet<T>(key, this.idbStore)) ?? defaultValue);

		// Set up a listener to write to the idb store when the object changes
		this.unloads[key] = obyStore.on(reactiveObj, () => {
			this.pendingWrites[key] = idbSet(key, obyStore.unwrap(reactiveObj), this.idbStore).catch(
				this.trace.err.withContext(`Failed to set`, key, reactiveObj),
			);
		});

		return <T>(this.reactiveCache[key] = reactiveObj);
	}

	public async ensure<T>(key: string, defaultValue: T | (() => MaybePromise<T>), awaitSet: boolean = false): Promise<T> {
		const value = await this.get<T>(key);
		if (value === undefined) {
			// Reduce defaultValue to its actual value
			defaultValue = defaultValue instanceof Function ? await defaultValue() : defaultValue;
			const setPromise = this.set(key, defaultValue).catch(this.trace.err.withContext(`Failed to set`, key, defaultValue));
			// Only wait for set to complete if awaitSet is true
			if (awaitSet) await setPromise;
			return defaultValue;
		}
		return value;
	}

	public get<T>(key: string): Promise<T | undefined> {
		return idbGet<T>(key, this.idbStore);
	}

	public async set<T>(key: string, value: T) {
		try {
			await idbSet(key, value, this.idbStore);
			if (key in this.reactiveCache) {
				// Reconcile the reactive object with the new value
				obyStore.reconcile(this.reactiveCache[key], value);
			}
			return value;
		} catch (err) {
			this.trace.err.withContext(`Failed to set`, key, value)(err);
			throw err;
		}
	}

	/**
	 * Deletes a key and stops persisting the reactive object behind it.
	 *
	 * A change made just before this queues a write that would otherwise land after the delete and put the key back (an
	 * uninstalled plugin resurrecting itself), so stop the listener, let that write finish, then delete.
	 */
	public async del(key: string) {
		this.unloads[key]?.();
		delete this.unloads[key];
		await this.pendingWrites[key]?.catch(() => undefined);
		delete this.pendingWrites[key];
		delete this.reactiveCache[key];
		await idbDel(key, this.idbStore);
	}

	public keys(): Promise<string[]> {
		return idbKeys(this.idbStore);
	}

	public async dump(): Promise<Record<string, unknown>>
	{
		const allKeys = await this.keys();
		const data: Record<string, unknown> = {};
		for (const key of allKeys)
			data[key] = await this.get(key);

		return data;
	}

	public async clear()
	{
		const allKeys = await this.keys();
		for (const key of allKeys)
			await this.del(key);
	}
}
