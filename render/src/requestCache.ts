import { Cache } from "../../native/cache/Cache";
import { tidalRequestKey, tidalRequestPath } from "../../native/tidalHosts";
import type { LunaUnloads } from "./helpers/unloadSet";

export type RequestCacheRule = {
	/** GET requests whose url matches are cached, whoever makes them (TIDAL or Luna) */
	pattern: RegExp;
	/** Other urls a response is also the answer for, e.g. a playbackinfo response under the quality it actually returned */
	extraUrls?: (url: URL, value: unknown) => (string | URL)[];
	/**
	 * Also answer TIDAL's own matching requests from the cache (stale-while-revalidate): a cached response is returned at once
	 * and re-fetched in the background when older than `revalidateAfterMs`, a changed response is reported to `requestCache.onChange`
	 */
	swr?: true;
	/** Entries older than this are re-fetched, e.g. while urls in them are valid */
	maxAgeMs?: number;
	/** Also answer TIDAL's own matching requests from any cached value (Luna's or TIDAL's), as this json for its request headers */
	respond?: (value: unknown, headers: Headers) => unknown;
};

type RawResponse = { status: number; statusText: string; headers: Headers; etag: string | null; body: string };
type Entry = {
	/** The parsed response, only parsed when something asks for it as TIDAL parses its own */
	value?: Promise<unknown>;
	/** The response as received, only for entries filled by a fetch through the hook, which can be served to TIDAL */
	raw?: Promise<RawResponse>;
	time: number;
	revalidating?: true;
};

const rules = new Set<RequestCacheRule>();
/** In-flight entries that may fill extraUrls, by path */
const pending = new Map<Promise<unknown>, string>();
const changeListeners = new Set<(url: string) => void>();
/** Keys a `get` fetcher is fetching */
const fetching = new Set<string>();

/**
 * A response served from the cache is re-fetched in the background when older than this, so going back and forth doesn't re-fetch every page.
 * Served however old (unless a rule's `maxAgeMs` says otherwise): it re-renders through `onChange` when the re-fetch differs and mutations drop
 * what they change, so a page revisited after a break shows at once instead of waiting on the network
 */
const revalidateAfterMs = 60_000;
/** Entries in memory, past this the least recently and frequently used are dropped (see native/cache/Cache.ts) */
const entries = new Cache<Entry>({ maxEntries: 10_000 });
const stats = { served: 0, fetched: 0 };

const maxAgeOf = (href: string) => {
	let maxAge = Infinity;
	for (const rule of rules) if (rule.maxAgeMs !== undefined && rule.pattern.test(href)) maxAge = Math.min(maxAge, rule.maxAgeMs);
	return maxAge;
};

const pathOf = tidalRequestPath;
const keyOf = tidalRequestKey;

const parse = (raw: RawResponse) => {
	if (raw.status >= 200 && raw.status < 300) return JSON.parse(raw.body);
	if (!raw.headers.has("x-luna-offline-miss") && (raw.status === 403 || raw.status === 404)) return undefined;
	throw new Error(`${raw.status} ${raw.statusText}`);
};
const drop = (key: string, entry: Entry) => entries.peek(key) === entry && entries.delete(key);
const valueOf = (key: string, entry: Entry) => {
	if (entry.value === undefined) {
		entry.value = entry.raw!.then(parse);
		entry.value.catch(() => drop(key, entry));
	}
	return entry.value;
};

const store = (url: URL, key: string, value: Promise<unknown> | undefined, raw?: Promise<RawResponse>) => {
	const entry: Entry = { value, raw, time: Date.now() };
	(raw ?? value)!.catch(() => drop(key, entry));
	entries.set(key, entry);
	const aliasRules: Required<RequestCacheRule>[] = [];
	for (const rule of rules) if (rule.extraUrls !== undefined && rule.pattern.test(url.href)) aliasRules.push(<Required<RequestCacheRule>>rule);
	if (aliasRules.length === 0) return entry;
	const resolving = valueOf(key, entry);
	pending.set(resolving, pathOf(url));
	resolving
		.then(
			(resolved) => {
				for (const rule of aliasRules) {
					for (const extra of rule.extraUrls(url, resolved)) {
						const extraKey = keyOf(new URL(extra));
						if (!entries.has(extraKey)) entries.set(extraKey, entry);
					}
				}
			},
			() => {},
		)
		.finally(() => pending.delete(resolving));
	return entry;
};

const readRaw = async (res: Response): Promise<RawResponse> => {
	// Cloned synchronously, before the caller's handlers can read the body
	const clone = res.clone();
	return { status: res.status, statusText: res.statusText, headers: res.headers, etag: res.headers.get("etag"), body: await clone.text() };
};
// Some apis (openapi playlist items) return the same json with keys in another order
const sortedKeys = (_: string, value: unknown) => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) sorted[key] = (<Record<string, unknown>>value)[key];
	return sorted;
};
const sameJson = (a: string, b: string) => {
	try {
		return JSON.stringify(JSON.parse(a), sortedKeys) === JSON.stringify(JSON.parse(b), sortedKeys);
	} catch {
		return false;
	}
};
const sameResponse = (a: RawResponse, b: RawResponse) =>
	a.status === b.status && ((a.etag !== null && a.etag === b.etag) || a.body === b.body || sameJson(a.body, b.body));

// Path segments and query values that name an item (numeric, uuid and hex mix ids), they have a digit unlike v1 or playlists
const idLike = /^(?=.*\d)[\w-]{3,}$/;
/** Drop every entry mentioning an item a mutation of `url` changes, e.g. a playlist on edit, a user's collection on (un)favorite */
const invalidate = (url: URL) => {
	const ids: string[] = [];
	for (const part of url.pathname.split("/")) if (idLike.test(part)) ids.push(part);
	for (const value of url.searchParams.values()) for (const part of value.split(",")) if (idLike.test(part)) ids.push(part);
	if (ids.length === 0) return;
	for (const key of [...entries.keys()]) {
		for (const id of ids) {
			if (!key.includes(id)) continue;
			entries.delete(key);
			break;
		}
	}
};

/**
 * Cache of request responses shared by everything in the page.
 * Responses to requests matching a registered rule fill it. TIDAL's own requests are only served from it for `swr` rules.
 */
const statsOf = () => ({ ...entries.stats(), ...stats });
export const requestCache = {
	register(unloads: LunaUnloads, rule: RequestCacheRule) {
		rules.add(rule);
		unloads.add(() => rules.delete(rule));
	},
	/** Calls `listener` with the url of a cached response that changed when re-fetched in the background */
	onChange(unloads: LunaUnloads, listener: (url: string) => void) {
		changeListeners.add(listener);
		unloads.add(() => changeListeners.delete(listener));
	},
	/** Drops every entry, e.g. on logout */
	clear() {
		entries.clear();
	},
	/** The entries held and how many TIDAL requests were answered from the cache and how many went to the network through it */
	stats() {
		return statsOf();
	},
	/** Calls `listener` when the stats changed, at most once a second */
	onStats(unloads: LunaUnloads, listener: (stats: ReturnType<typeof statsOf>) => void) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const unload = entries.onChange(() => (timer ??= setTimeout(() => ((timer = undefined), listener(statsOf())), 1000)));
		unloads.add(() => (clearTimeout(timer), unload()));
	},
	/**
	 * The cached or in-flight value for `url`, otherwise the result of `fetcher` which is cached.
	 * Concurrent calls (and matching TIDAL requests) share a single request.
	 */
	get<T>(url: string, fetcher: () => Promise<T | undefined>): Promise<T | undefined> {
		const parsed = new URL(url);
		const key = keyOf(parsed);
		const entry = entries.get(key);
		// A failed entry is already deleted when this runs (e.g. TIDAL aborted its request), so this fetches
		if (entry !== undefined && Date.now() - entry.time <= maxAgeOf(parsed.href)) return (<Promise<T | undefined>>valueOf(key, entry)).catch(() => requestCache.get(url, fetcher));
		// A request in flight for the same path may answer this one through extraUrls (e.g. playbackinfo at another quality)
		const path = pathOf(parsed);
		const samePath: Promise<unknown>[] = [];
		pending.forEach((pendingPath, value) => pendingPath === path && samePath.push(value));
		if (samePath.length !== 0) return Promise.allSettled(samePath).then(() => requestCache.get(url, fetcher));
		// Run fetcher after the entry is stored so the fetch hook sees its own request as cached, and doesn't answer it from itself
		const value = Promise.resolve()
			.then(() => (fetching.add(key), fetcher()))
			.finally(() => fetching.delete(key));
		return <Promise<T | undefined>>store(parsed, key, value).value;
	},
};

const fetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const fill = (url: URL, key: string, input: FetchInput, init: FetchInit) => {
	stats.fetched++;
	const res = fetch.call(globalThis, input, init);
	try {
		// Attached before the caller's handlers, so the clone is taken before the body is read
		store(url, key, undefined, res.then(readRaw));
	} catch {
		// Never break a request because of caching
	}
	return res;
};

const revalidate = (url: URL, key: string, entry: Entry, input: FetchInput, init: FetchInit) => {
	// Without the caller's signal, the caller going away shouldn't drop the entry
	const request = new Request(input, { ...init, signal: null });
	entry.revalidating = true;
	fetch
		.call(globalThis, request)
		.then(readRaw)
		.then(async (raw) => {
			if (entries.peek(key) !== entry || raw.headers.has("x-luna-offline-miss")) return;
			const old = await entry.raw!;
			if (raw.status === 304 || sameResponse(old, raw)) return void (entry.time = Date.now());
			if (raw.status !== 200) return void entries.delete(key);
			store(url, key, undefined, Promise.resolve(raw));
			for (const listener of changeListeners) listener(url.href);
		})
		.catch(() => drop(key, entry))
		.finally(() => delete entry.revalidating);
};

/** A response for a TIDAL request from an `swr` entry, if there is one to serve */
const fromCache = (url: URL, key: string, input: FetchInput, init: FetchInit): Promise<Response> | undefined => {
	const cacheMode = init?.cache ?? (input instanceof Request ? input.cache : "default");
	if (cacheMode === "no-store" || cacheMode === "no-cache" || cacheMode === "reload") return;
	const entry = entries.get(key);
	if (entry?.raw === undefined) return;
	const age = Date.now() - entry.time;
	if (age > maxAgeOf(url.href)) return;
	if (age > revalidateAfterMs && !entry.revalidating) revalidate(url, key, entry, input, init);
	const fallback = () => fill(url, key, input, init);
	return entry.raw.then((raw) => {
		if (raw.status !== 200) return fallback();
		stats.served++;
		const res = new Response(raw.body, { status: raw.status, statusText: raw.statusText, headers: raw.headers });
		Object.defineProperty(res, "url", { value: url.href });
		return res;
	}, fallback);
};

/** A response for a TIDAL request made by a `respond` rule from a fresh entry, otherwise its fetch */
const respondFrom = (rule: Required<Pick<RequestCacheRule, "respond">>, url: URL, key: string, input: FetchInput, init: FetchInit) => {
	const entry = entries.get(key);
	if (entry === undefined || Date.now() - entry.time > maxAgeOf(url.href)) return fill(url, key, input, init);
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	return valueOf(key, entry).then(
		(value) => {
			if (value === undefined) return fill(url, key, input, init);
			stats.served++;
			const res = new Response(JSON.stringify(rule.respond(value, headers)), { headers: { "content-type": "application/json" } });
			Object.defineProperty(res, "url", { value: url.href });
			return res;
		},
		() => fill(url, key, input, init),
	);
};

/** The response for a request the cache handles, `undefined` for the rest */
const cachedFetch = (input: FetchInput, init: FetchInit): Promise<Response> | undefined => {
	if (rules.size === 0) return;
	const url = new URL(input instanceof Request ? input.url : String(input), location.href);
	const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	if (method !== "GET") {
		if (url.hostname !== "tidal.com" && !url.hostname.endsWith(".tidal.com")) return;
		// Before and after, so nothing fetched while the mutation is in flight stays cached
		invalidate(url);
		const res = fetch.call(globalThis, input, init);
		res.finally(() => invalidate(url)).catch(() => {});
		return res;
	}
	const href = url.href;
	let matched = false;
	let swr = false;
	let responder: Required<Pick<RequestCacheRule, "respond">> | undefined;
	for (const rule of rules) {
		if (!rule.pattern.test(href)) continue;
		matched = true;
		if (rule.swr) swr = true;
		if (rule.respond !== undefined) responder = <Required<Pick<RequestCacheRule, "respond">>>rule;
	}
	if (!matched) return;
	const key = keyOf(url);
	if (responder !== undefined && !fetching.has(key)) return respondFrom(responder, url, key, input, init);
	// An swr entry not served (stale, uncacheable or filled by a Luna fetcher) is replaced, other entries are kept
	if (swr) return fromCache(url, key, input, init) ?? fill(url, key, input, init);
	return entries.has(key) ? undefined : fill(url, key, input, init);
};

globalThis.fetch = function (input: FetchInput, init?: FetchInit) {
	let res: Promise<Response> | undefined;
	try {
		res = cachedFetch(input, init);
	} catch {
		// Never break a request because of caching
	}
	return res ?? fetch.call(globalThis, input, init);
};
