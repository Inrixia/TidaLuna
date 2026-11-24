import { tidalRequestKey, tidalRequestPath } from "../../../native/tidalHosts";
import type { Cache, CacheStore, MapBackend } from "../../../cache";
import type { LunaUnloads } from "../helpers/unloadSet";
import { createLogger } from "../trace/createLogger";
import { parse, readRaw, sameResponse, type RawResponse } from "./SharedRequests.responses";

export type SharedRequestsRule = {
	/** GET requests whose url matches are cached, whoever makes them (TIDAL or Luna) */
	pattern: RegExp;
	/** Other urls a response is also the answer for, e.g. a playbackinfo response under the quality it actually returned */
	extraUrls?: (url: URL, value: unknown) => (string | URL)[];
	/**
	 * Also answer TIDAL's own matching requests from the cache, stale-while-revalidate: a cached response is returned at once (however old,
	 * within `maxAgeMs`) and, when older than `SharedRequests.revalidateAfterMs`, fetched again in the background. If that differs the entry
	 * is replaced and `onChange` tells the page to re-render. Pages show at once instead of waiting on the network, and stay current
	 */
	swr?: true;
	/** Entries older than this are fetched again, e.g. while urls in them are valid */
	maxAgeMs?: number;
	/** Also answer TIDAL's own matching requests from any cached value (Luna's or TIDAL's), as this json for its request headers */
	respond?: (value: unknown, headers: Headers) => unknown;
};

/** A cached request. Requests are cached as they are made, so concurrent requests for a url share one */
export type Entry = {
	/** The parsed response, only parsed when something asks for it as TIDAL parses its own */
	value?: Promise<unknown>;
	/** The response as received, only for entries filled by a fetch through the hook (fetchHook.ts), which can be served to TIDAL */
	raw?: Promise<RawResponse>;
	/** The request that fetched `raw`, fetched again to revalidate an `swr` entry */
	request?: Request;
};

/** A memory only cache of entries, whose values are the entries themselves (holding promises) */
type RequestsCache = Cache<CacheStore<MapBackend<any>, MapBackend<Entry>>, undefined>;

/**
 * Responses to GET requests shared by everything in the page, keyed by `tidalRequestKey` so both TIDAL api hosts share them.
 * Responses to requests matching a registered rule fill it, whoever makes them. TIDAL's own requests are only answered from it for `swr` and `respond` rules.
 * Kept in memory only by default, the offline cache in the main process (native/OfflineResponses) keeps responses across restarts
 */
export class SharedRequests {
	/** A response is fetched again in the background when read older than this, see `SharedRequestsRule.swr` */
	public static readonly revalidateAfterMs = 60_000;
	/** The page's fetch before the hook (SharedRequests.fetchHook.ts) wrapped it, so the cache's own fetches aren't answered from itself */
	public static readonly fetch = globalThis.fetch;

	// Not the Tracer: this loads before TIDAL's internals it shows messages through
	public readonly logErr = createLogger("[@luna/core.sharedRequests]", console.error);
	public readonly rules = new Set<SharedRequestsRule>();
	/** Keys a `request` fetcher is fetching, the fetch hook leaves those requests to it */
	public readonly fetching = new Set<string>();
	/** Entries resolving that may fill `extraUrls`, by path */
	private readonly resolving = new Map<Promise<unknown>, string>();
	/** TIDAL requests answered from the cache, and fetched through it */
	public served = 0;
	public fetched = 0;

	/** @param cache memory only, see `RequestsCache`. Hooks are attached for the session, so never unloaded */
	public constructor(private readonly cache: RequestsCache) {
		cache.attach(
			{
				revalidate: (key, entry) => this.revalidate(key, entry),
				sizeOf: (entry) => this.sizeOf(entry),
				// TIDAL's requests answered from the cache, and fetched through it
				stats: () => ({ served: this.served, fetched: this.fetched }),
			},
			new Set(),
		);
	}

	public onChange(...args: Parameters<RequestsCache["onChange"]>) {
		return this.cache.onChange(...args);
	}
	public clear() {
		return this.cache.clear();
	}
	public stats() {
		return this.cache.stats();
	}
	public keys() {
		return this.cache.keys();
	}
	public has(key: string) {
		return this.cache.has(key);
	}
	public get(key: string): Entry | undefined {
		return this.cache.get(key);
	}
	public peek(key: string): Entry | undefined {
		return this.cache.peek(key);
	}
	/** Removes `key`, only if its entry is still `entry` when given */
	public delete(key: string, entry?: Entry) {
		return this.cache.delete(key, entry);
	}

	/** The response's length once it arrives, a failed request drops its entry */
	private sizeOf(entry: Entry) {
		return entry.raw?.then((raw) => raw.body.length) ?? entry.value!.then((value) => JSON.stringify(value)?.length ?? 0);
	}
	/** Fetches an `swr` entry's request again: a changed response replaces it, the same one makes it fresh again */
	private async revalidate(_key: string, entry: Entry): Promise<Entry | undefined> {
		// Without the caller's signal, the caller going away shouldn't drop the entry
		const raw = await SharedRequests.fetch.call(globalThis, entry.request!).then(readRaw);
		// Offline and not in the offline cache: kept as is, tried again on the next read
		if (raw.headers.has("x-luna-offline-miss")) return entry;
		if (raw.status === 304 || sameResponse(await entry.raw!, raw)) return undefined;
		if (raw.status !== 200) throw new Error(`${raw.status} ${raw.statusText}`);
		return { raw: Promise.resolve(raw), request: entry.request };
	}

	public register(unloads: LunaUnloads, rule: SharedRequestsRule) {
		this.rules.add(rule);
		unloads.add(() => this.rules.delete(rule));
	}

	/** The parsed value of `entry`, parsed on first use. A failed entry is dropped */
	public parsed(key: string, entry: Entry) {
		if (entry.value === undefined) {
			entry.value = entry.raw!.then(parse);
			entry.value.catch(() => this.delete(key, entry));
		}
		return entry.value;
	}

	/**
	 * Caches a request for `url` by its parsed `value` (Luna's) or `raw` response and `request` (fetched through the hook), and under its rules'
	 * `extraUrls` once it resolves. Entries expire after the shortest `maxAgeMs` of the rules matching, `swr` ones filled by the hook are revalidated
	 */
	public store(url: URL, key: string, value: Promise<unknown> | undefined, raw?: Promise<RawResponse>, request?: Request) {
		const entry: Entry = { value, raw, request };
		const replaced = this.peek(key);
		let maxAgeMs = Infinity;
		let swr = false;
		const aliasRules: Required<SharedRequestsRule>[] = [];
		for (const rule of this.rules) {
			if (!rule.pattern.test(url.href)) continue;
			if (rule.maxAgeMs !== undefined) maxAgeMs = Math.min(maxAgeMs, rule.maxAgeMs);
			if (rule.swr) swr = true;
			if (rule.extraUrls !== undefined) aliasRules.push(<Required<SharedRequestsRule>>rule);
		}
		const options = { maxAgeMs, revalidateAfterMs: swr && request !== undefined ? SharedRequests.revalidateAfterMs : undefined };
		// Held as soon as this is called, a memory only cache's `set` doesn't wait before it
		void this.cache.set(key, entry, options);
		if (aliasRules.length === 0) return entry;

		const resolving = this.parsed(key, entry);
		this.resolving.set(resolving, tidalRequestPath(url));
		resolving
			.then(
				(resolved) => {
					for (const rule of aliasRules) {
						for (const extra of rule.extraUrls(url, resolved)) {
							const extraKey = tidalRequestKey(new URL(extra));
							// Sized under its own key, the entry is shared. Replaces what the entry it replaced was aliased as
							const aliased = this.peek(extraKey);
							if (aliased === undefined || (replaced !== undefined && aliased === replaced)) void this.cache.set(extraKey, entry, options);
						}
					}
				},
				() => {},
			)
			.finally(() => this.resolving.delete(resolving));
		return entry;
	}

	// Path segments and query values that name an item (numeric, uuid and hex mix ids), they have a digit unlike v1 or playlists
	private static readonly idLike = /^(?=.*\d)[\w-]{3,}$/;
	/** Drops every entry mentioning an item a mutation of `url` changes, e.g. a playlist on edit, a user's collection on (un)favorite */
	public invalidate(url: URL) {
		const ids: string[] = [];
		for (const part of url.pathname.split("/")) if (SharedRequests.idLike.test(part)) ids.push(part);
		for (const value of url.searchParams.values()) for (const part of value.split(",")) if (SharedRequests.idLike.test(part)) ids.push(part);
		if (ids.length === 0) return;
		// Deleting the entry being visited doesn't disturb a Map's iteration
		for (const key of this.keys()) if (ids.some((id) => key.includes(id))) void this.delete(key);
	}

	/**
	 * The cached or in-flight value for `url`, otherwise the result of `fetcher` which is cached.
	 * Concurrent calls (and matching TIDAL requests) share a single request.
	 */
	public request<T>(url: string, fetcher: () => Promise<T | undefined>): Promise<T | undefined> {
		const parsed = new URL(url);
		const key = tidalRequestKey(parsed);
		const entry = this.get(key);
		// A failed entry is already dropped when this runs (e.g. TIDAL aborted its request), so this fetches
		if (entry !== undefined) return (<Promise<T | undefined>>this.parsed(key, entry)).catch(() => this.request(url, fetcher));

		// A request in flight for the same path may answer this one through extraUrls (e.g. playbackinfo at another quality)
		const path = tidalRequestPath(parsed);
		const samePath: Promise<unknown>[] = [];
		for (const [value, resolvingPath] of this.resolving) if (resolvingPath === path) samePath.push(value);
		if (samePath.length !== 0) return Promise.allSettled(samePath).then(() => this.request(url, fetcher));

		// Run fetcher after the entry is stored so the fetch hook sees its own request as cached, and doesn't answer it from itself
		const value = Promise.resolve()
			.then(() => (this.fetching.add(key), fetcher()))
			.finally(() => this.fetching.delete(key));
		return <Promise<T | undefined>>this.store(parsed, key, value).value;
	}
}
