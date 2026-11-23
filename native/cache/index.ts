// What the page can do with every DiskCache, by its name (`audio`, `offline`). Exposed through native/expose.ts
import { diskCaches, type DiskCacheStats } from "./DiskCache";

export { Cache, type CacheStats } from "./Cache";
export { DiskCache, type DiskCacheStats } from "./DiskCache";

const cacheOf = (name: string) => {
	const cache = diskCaches.get(name);
	if (cache === undefined) throw new Error(`No cache named ${name}`);
	return cache;
};

export const cacheStats = async (name: string): Promise<DiskCacheStats> => (await cacheOf(name).ready, cacheOf(name).stats());
export const cacheList = async (): Promise<DiskCacheStats[]> => Promise.all([...diskCaches.keys()].map(cacheStats));
/** Bytes the cache may use, `undefined` for its default. Resolves once what no longer fits is deleted */
export const cacheSetLimit = (name: string, bytes?: number) => cacheOf(name).setLimit(bytes);
export const cacheOpenFolder = (name: string) => cacheOf(name).openFolder();
/** Deletes everything in the cache that isn't in use */
export const cacheClear = (name: string) => cacheOf(name).clear();
