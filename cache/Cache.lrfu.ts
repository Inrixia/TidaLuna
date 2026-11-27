// LRFU eviction: every entry has a read score `crf` that halves every `halfLifeMs` and gains 1 per read, so it weighs recent reads over old
// ones and frequent reads over rare ones. Each store evicts its lowest ranked entries once over its limit
import type { CacheMeta } from "./Cache.types";

const MB = 1024 ** 2;

/** Whether `meta`'s entry is past its `maxAgeMs` */
export const expired = (meta: CacheMeta, now = Date.now()) => meta.maxAgeMs !== undefined && meta.written + meta.maxAgeMs <= now;

/**
 * Eviction rank: the log2 of the score scaled to time 0 (`crf * 2 ** (last / halfLifeMs)`), so ranks never need decaying to compare.
 * Lowest goes first, expired entries before all others
 */
export const rank = (meta: CacheMeta, halfLifeMs: number) => {
	// Finite, so differences between ranks stay numbers
	if (expired(meta)) return Number.MIN_SAFE_INTEGER;
	return meta.last / halfLifeMs + Math.log2(meta.crf);
};

/** Counts a read of `meta` at `now`: its score decays from `last` to now, then gains 1 */
export const touch = (meta: CacheMeta, halfLifeMs: number, now = Date.now()) => {
	meta.crf = meta.crf * 2 ** (-(now - meta.last) / halfLifeMs) + 1;
	meta.last = now;
};

/** Bytes evicting goes under a limit so the next writes don't each evict again: 2% of it, at most 256 MiB */
export const slackOf = (bytesLimit: number) => Math.min(bytesLimit * 0.02, 256 * MB);
