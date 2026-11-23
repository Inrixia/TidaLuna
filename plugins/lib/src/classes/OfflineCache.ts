import { Cache } from "./Cache";

/** The cache of the page's responses replayed when offline, see native/offlineCache.ts */
export class OfflineCache extends Cache {
	public constructor() {
		super("offline", "@luna/lib.OfflineCache");
	}
}

export const offlineCache = new OfflineCache();
