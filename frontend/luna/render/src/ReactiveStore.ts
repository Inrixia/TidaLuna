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

		// Create the oby reactive object
		const reactiveObj = obyStore(defaultValue);
		// Reconcile the object with the idb store to ensure we have the latest values
		obyStore.reconcile(reactiveObj, (await idbGet<T>(key, this.idbStore)) ?? defaultValue);

		// Set up a listener to write to the idb store when the object changes
		obyStore.on(reactiveObj, () =>
			idbSet(key, obyStore.unwrap(reactiveObj), this.idbStore).catch(this.trace.err.withContext(`Failed to set`, key, reactiveObj)),
		);

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

	public del(key: string) {
		return idbDel(key, this.idbStore);
	}

	public keys(): Promise<string[]> {
		return idbKeys(this.idbStore);
	}
}
