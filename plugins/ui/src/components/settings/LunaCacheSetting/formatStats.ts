import { formatBytes } from "@luna/core";

/** `memoryBytes` > `Memory bytes` */
export const labelOf = (key: string) => {
	const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
	return words[0].toUpperCase() + words.slice(1);
};

/** Keys of `CacheStats.extra` ending in `Bytes` are bytes, the rest counts */
export const formatExtra = (key: string, value: number) => (key.endsWith("Bytes") ? formatBytes(value) : value.toLocaleString());

/** `hits / (hits + misses)` as a percent, `-` before any lookup */
export const hitRate = (hits: number, misses: number) => (hits + misses === 0 ? "-" : `${Math.round((hits / (hits + misses)) * 100)}%`);

/** Percent of `limit` that `bytes` takes, 0 without a finite limit */
export const percentOf = (bytes: number, limit: number) => (Number.isFinite(limit) && limit > 0 ? Math.min(100, (bytes / limit) * 100) : 0);

/** `native:audio` > `audio` */
export const keyTitle = (key: string) => labelOf(key.replace(/^native:/, ""));
