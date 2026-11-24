import { cacheClear, cacheList, cacheOpenLocation, cacheSetLimit, cacheStats } from "../../../lib.native/src/index.native";

import type { AddReceiver } from "@inrixia/helpers";
import { Cache, type CacheControl, type CacheStats } from "@luna/core";

import { libTrace, unloads } from "../index.safe";
import * as ipc from "../ipc";

/**
 * A cache in the main process (see native/caches.ts, e.g. offline) worked through IPC, so the page lists and controls it in
 * `Cache.controls` with its own caches, keyed `native:<key>`. Every main process cache has one once `NativeCache.loaded` resolves
 */
export class NativeCache implements CacheControl {
	public static readonly loaded: Promise<void> = cacheList().then(
		(list) => void list.forEach((stats) => NativeCache.add(stats.key)),
		libTrace.err.withContext("NativeCache.loaded"),
	);
	static {
		// Caches made in the main process after the list was read
		ipc.on(unloads, "__Luna.cacheAdded", (nativeKey: string) => NativeCache.add(nativeKey));
	}

	/** Adds a control for the main process cache `nativeKey` unless there is one */
	private static add(nativeKey: string) {
		if (!Cache.controls.has(`native:${nativeKey}`)) Cache.addControl(new NativeCache(nativeKey));
	}

	public readonly key: string;
	private constructor(private readonly nativeKey: string) {
		this.key = `native:${nativeKey}`;
	}

	/** The stats as the page keys them */
	private rekey(stats: CacheStats): CacheStats {
		return { ...stats, key: this.key };
	}

	public async stats(): Promise<CacheStats> {
		return this.rekey(await cacheStats(this.nativeKey));
	}
	/** The stats the main process pushes as they change, see native/caches.ts */
	public readonly onStats: AddReceiver<CacheStats> = (unloads, listener) =>
		ipc.on(unloads, "__Luna.cacheStats", (stats: CacheStats) => {
			if (stats.key === this.nativeKey) listener(this.rekey(stats));
		});
	public setUserBytesLimit(bytes?: number): Promise<void> {
		return cacheSetLimit(this.nativeKey, bytes);
	}
	public clear(): Promise<void> {
		return cacheClear(this.nativeKey);
	}
	public openLocation(): Promise<string | undefined> {
		return cacheOpenLocation(this.nativeKey);
	}
}
