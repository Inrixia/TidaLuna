import type { MaybePromise } from "@inrixia/helpers";

import type { CacheMeta } from "./Cache.types";

/**
 * Behaviour a wrapper adds to its cache through `Cache.attach`, e.g. `SharedRequests` revalidating responses. Attached rather than given to
 * `Cache.from` because the factory runs once per key: after a plugin reload its closures would be the old plugin's. Detached on unload
 */
export type CacheHooks<V, X> = {
	/**
	 * Fetches a value again, called in the background when a value older than its `revalidateAfterMs` is read. Resolves to:
	 * a new value, which replaces it and tells `onChange` listeners; `undefined` if unchanged, so it is fresh again;
	 * the same `value` to keep it as is (e.g. offline), tried again on the next read. A rejection drops the entry
	 */
	revalidate?: (key: string, value: V, meta: CacheMeta<X>) => Promise<V | undefined>;
	/** Bytes a value takes in every store, instead of each data backend's `sizeOf`. May resolve later: a rejection drops the entry */
	sizeOf?: (value: V) => MaybePromise<number>;
	/** An entry that can't be evicted or cleared now, e.g. the track playing */
	isPinned?: (key: string) => boolean;
	/** Caps the cache's limit whatever the user set, read on every eviction, e.g. a share of the free disk space */
	maxBytesLimit?: () => number;
	/** Counters of the wrapper's own for the UI, shown as `CacheStats.extra` */
	stats?: () => Record<string, number>;
};
