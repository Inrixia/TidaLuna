// Hooks the page's fetch, so TIDAL's requests matching a SharedRequests rule fill it and, for `swr` and `respond` rules, are answered from it
import { tidalRequestKey } from "../../../native/tidalHosts";
import { SharedRequests, type SharedRequestsRule } from "./SharedRequests";
import { readRaw, toResponse } from "./SharedRequests.responses";

const fetch = SharedRequests.fetch;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type Responder = Required<Pick<SharedRequestsRule, "respond">>;

export const hookFetch = (cache: SharedRequests) => {
	/** Fetches a request and caches its response, with the request to fetch it again by if it is `swr` (see `SharedRequests.revalidate`) */
	const fill = (url: URL, key: string, input: FetchInput, init: FetchInit, swr = false) => {
		cache.fetched++;
		const res = fetch.call(globalThis, input, init);
		try {
			// Without the caller's signal, the caller going away shouldn't fail a revalidation
			const request = swr ? new Request(input, { ...init, signal: null }) : undefined;
			// Attached before the caller's handlers, so the clone is taken before the body is read
			cache.store(url, key, undefined, res.then(readRaw), request);
		} catch (err) {
			// Never break a request because of caching
			cache.logErr.withContext("store", url.href)(err);
		}
		return res;
	};

	/** A response for a TIDAL request from an `swr` entry, if there is one to serve. Reading it revalidates it once stale */
	const fromCache = (url: URL, key: string, input: FetchInput, init: FetchInit): Promise<Response> | undefined => {
		const cacheMode = init?.cache ?? (input instanceof Request ? input.cache : "default");
		if (cacheMode === "no-store" || cacheMode === "no-cache" || cacheMode === "reload") return;
		const entry = cache.get(key);
		if (entry?.raw === undefined) return;

		const fallback = () => fill(url, key, input, init, true);
		return entry.raw.then((raw) => {
			if (raw.status !== 200) return fallback();
			cache.served++;
			return toResponse(url, raw.body, { status: raw.status, statusText: raw.statusText, headers: raw.headers });
		}, fallback);
	};

	/** A response for a TIDAL request made by a `respond` rule from a fresh entry, otherwise its fetch */
	const respondFrom = (rule: Responder, url: URL, key: string, input: FetchInput, init: FetchInit) => {
		const entry = cache.get(key);
		if (entry === undefined) return fill(url, key, input, init);
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		return cache.parsed(key, entry).then(
			(value) => {
				if (value === undefined) return fill(url, key, input, init);
				cache.served++;
				return toResponse(url, JSON.stringify(rule.respond(value, headers)), { headers: { "content-type": "application/json" } });
			},
			() => fill(url, key, input, init),
		);
	};

	/** A mutation (non GET) of TIDAL's drops the entries it changes, before and after so nothing fetched while it is in flight stays cached */
	const mutate = (url: URL, input: FetchInput, init: FetchInit) => {
		if (url.hostname !== "tidal.com" && !url.hostname.endsWith(".tidal.com")) return;
		cache.invalidate(url);
		const res = fetch.call(globalThis, input, init);
		res.finally(() => cache.invalidate(url)).catch(() => {});
		return res;
	};

	/** The response for a request the cache handles, `undefined` for the rest */
	const cachedFetch = (input: FetchInput, init: FetchInit): Promise<Response> | undefined => {
		if (cache.rules.size === 0) return;
		const url = new URL(input instanceof Request ? input.url : String(input), location.href);
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		if (method !== "GET") return mutate(url, input, init);

		let matched = false;
		let swr = false;
		let responder: Responder | undefined;
		for (const rule of cache.rules) {
			if (!rule.pattern.test(url.href)) continue;
			matched = true;
			if (rule.swr) swr = true;
			if (rule.respond !== undefined) responder = <Responder>rule;
		}
		if (!matched) return;

		const key = tidalRequestKey(url);
		if (responder !== undefined && !cache.fetching.has(key)) return respondFrom(responder, url, key, input, init);
		// An swr entry not served (expired, uncacheable or filled by a Luna fetcher) is replaced, other entries are kept
		if (swr) return fromCache(url, key, input, init) ?? fill(url, key, input, init, true);
		return cache.has(key) ? undefined : fill(url, key, input, init);
	};

	globalThis.fetch = function (input: FetchInput, init?: FetchInit) {
		let res: Promise<Response> | undefined;
		try {
			res = cachedFetch(input, init);
		} catch (err) {
			// Never break a request because of caching
			cache.logErr.withContext("fetch")(err);
		}
		return res ?? fetch.call(globalThis, input, init);
	};
};
