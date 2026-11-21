import type { LunaUnloads } from "./helpers/unloadSet";

export type RequestCacheRule = {
	/** GET requests whose url matches are cached, whoever makes them (TIDAL or Luna) */
	pattern: RegExp;
	/** Other urls a response is also the answer for, e.g. a playbackinfo response under the quality it actually returned */
	extraUrls?: (url: URL, value: unknown) => (string | URL)[];
};

const rules = new Set<RequestCacheRule>();
const entries = new Map<string, Promise<unknown>>();
/** In-flight entries that may fill extraUrls, by path */
const pending = new Map<Promise<unknown>, string>();

// Both hosts serve the same v1 api, TIDAL uses api. and Luna desktop.
const tidalHosts = new Set(["api.tidal.com", "desktop.tidal.com"]);
const pathOf = (url: URL) => `${tidalHosts.has(url.hostname) ? "tidal-v1" : url.host}${url.pathname}`;
const keyOf = (url: URL) => {
	const search = new URLSearchParams(url.search);
	search.sort();
	return `${pathOf(url)}?${search}`;
};

const matches = (href: string) => {
	for (const rule of rules) if (rule.pattern.test(href)) return true;
	return false;
};

const store = (url: URL, key: string, value: Promise<unknown>) => {
	entries.set(key, value);
	const aliasRules: Required<RequestCacheRule>[] = [];
	for (const rule of rules) if (rule.extraUrls !== undefined && rule.pattern.test(url.href)) aliasRules.push(<Required<RequestCacheRule>>rule);
	if (aliasRules.length !== 0) pending.set(value, pathOf(url));
	value
		.then(
			(resolved) => {
				for (const rule of aliasRules) {
					for (const extra of rule.extraUrls(url, resolved)) {
						const extraKey = keyOf(new URL(extra));
						if (!entries.has(extraKey)) entries.set(extraKey, value);
					}
				}
			},
			() => entries.get(key) === value && entries.delete(key),
		)
		.finally(() => pending.delete(value));
	return value;
};

/**
 * Cache of request responses shared by everything in the page.
 * TIDAL's own requests are never served from it, but responses to ones matching a registered rule fill it.
 */
export const requestCache = {
	register(unloads: LunaUnloads, rule: RequestCacheRule) {
		rules.add(rule);
		unloads.add(() => rules.delete(rule));
	},
	/**
	 * The cached or in-flight value for `url`, otherwise the result of `fetcher` which is cached.
	 * Concurrent calls (and matching TIDAL requests) share a single request.
	 */
	get<T>(url: string, fetcher: () => Promise<T | undefined>): Promise<T | undefined> {
		const parsed = new URL(url);
		const key = keyOf(parsed);
		const entry = <Promise<T | undefined> | undefined>entries.get(key);
		// A failed entry is already deleted when this runs (e.g. TIDAL aborted its request), so this fetches
		if (entry !== undefined) return entry.catch(() => requestCache.get(url, fetcher));
		// A request in flight for the same path may answer this one through extraUrls (e.g. playbackinfo at another quality)
		const path = pathOf(parsed);
		const samePath: Promise<unknown>[] = [];
		for (const [value, pendingPath] of pending) if (pendingPath === path) samePath.push(value);
		if (samePath.length !== 0) return Promise.allSettled(samePath).then(() => requestCache.get(url, fetcher));
		// Run fetcher after the entry is stored so the fetch hook sees its own request as cached
		return <Promise<T | undefined>>store(parsed, key, Promise.resolve().then(fetcher));
	},
};

const fetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
	const res = fetch.call(globalThis, input, init);
	try {
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (rules.size === 0 || method.toUpperCase() !== "GET") return res;
		const url = new URL(input instanceof Request ? input.url : String(input), location.href);
		if (!matches(url.href)) return res;
		const key = keyOf(url);
		if (entries.has(key)) return res;
		// Attached before the caller's handlers, so the clone is taken before the body is read
		store(
			url,
			key,
			res.then((r) => {
				if (r.ok) return r.clone().json();
				if (r.status === 403 || r.status === 404) return undefined;
				throw new Error(`${r.status} ${r.statusText}`);
			}),
		);
	} catch {
		// Never break a request because of caching
	}
	return res;
};
