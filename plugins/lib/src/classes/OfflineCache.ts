import { offlineCacheOpenFolder, offlineCacheSetLimit, offlineCacheStats, type OfflineCacheStats } from "../../../lib.native/src/index.native";

import { ReactiveStore } from "@luna/core";

import { libTrace } from "../index.safe";

export type { OfflineCacheStats };

/** The cache of the page's responses replayed when offline, see native/offlineCache.ts */
export class OfflineCache {
	private static readonly trace = libTrace.withSource("OfflineCache").trace;

	public static stats(): Promise<OfflineCacheStats> {
		return offlineCacheStats();
	}
	/** 0 for the default */
	private static readonly storage: Promise<{ limitBytes: number }> = ReactiveStore.getPluginStorage("@luna/lib.OfflineCache", { limitBytes: 0 });
	/** Bytes the cache may use, kept across restarts. 0 for the default of 1GB */
	public static async setLimit(bytes: number): Promise<void> {
		(await this.storage).limitBytes = bytes;
		return offlineCacheSetLimit(bytes || undefined);
	}
	public static openFolder(): Promise<string> {
		return offlineCacheOpenFolder();
	}

	static {
		this.storage.then(({ limitBytes }) => (limitBytes ? offlineCacheSetLimit(limitBytes) : undefined)).catch(this.trace.err.withContext("limit"));
	}
}
