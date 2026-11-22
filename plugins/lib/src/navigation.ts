import { Messager, ReactiveStore, recursiveSearch, requestCache, tidalModules } from "@luna/core";

import { getRouter, matchRoutes, type DataRoute, type DataRouter } from "./helpers/router";
import { safeTimeout } from "./helpers/safeTimeout";
import { libTrace, unloads } from "./index.safe";
import * as ipcRenderer from "./ipc";
import * as redux from "./redux";

let isOffline = !navigator.onLine;
const setOffline = (offline: boolean) => {
	if (offline === isOffline) return;
	isOffline = offline;
	if (offline) Messager.Warn("Offline — serving cached content");
	else Messager.Info("Back online");
};
if (isOffline) Messager.Warn("Offline — serving cached content");
// Keep TIDAL from replacing pages with its offline state when the OS network interface drops
redux.intercept("network/CONNECTION_LOST", unloads, () => true);
ipcRenderer.on(unloads, "__Luna.offlineStatus", setOffline);
const onOffline = () => setOffline(true);
const onOnline = () => {
	if (isOffline) fetch("https://api.tidal.com/v1/ping", { cache: "no-store" }).catch(() => {});
};
window.addEventListener("offline", onOffline);
window.addEventListener("online", onOnline);
unloads.add(() => {
	window.removeEventListener("offline", onOffline);
	window.removeEventListener("online", onOnline);
});

// TIDAL's route loaders wait on these before a page shows, serve them from the cache so revisits are instant
for (const pattern of [
	/^https:\/\/(api|desktop)\.tidal\.com\/v1\/(pages|playlists|albums|artists|mixes)\//,
	/^https:\/\/(api|desktop)\.tidal\.com\/v1\/users\/\d+\/(favorites|playlists|folders|blocks|mixes)\//,
	/^https:\/\/(api|desktop)\.tidal\.com\/v2\/(artist|home|feed|my-collection)\//,
	/^https:\/\/openapi\.tidal\.com\/v2\/(playlists|albums|artists|userCollection\w*)\//,
]) {
	requestCache.register(unloads, { pattern, swr: true });
}
redux.intercept("session/LOGOUT", unloads, () => requestCache.clear());

// Re-run the page's loaders when data it shows changed, they get the new response from the cache
let cancelRevalidate: (() => void) | undefined;
// The ids in `pathname` (e.g. a playlist's uuid), otherwise its last segment (e.g. explore, albums)
const isForPage = (url: string, pathname = location.pathname) => {
	const lower = url.toLowerCase();
	const segments = pathname.toLowerCase().split("/").filter(Boolean);
	const ids = segments.filter((segment) => /\d/.test(segment));
	const keys = ids.length !== 0 ? ids : segments[0] === "search" ? ["search"] : segments.length !== 0 ? segments.slice(-1) : ["home"];
	return keys.some((segment) => lower.includes(segment));
};
requestCache.onChange(unloads, (url) => {
	// A change to another page (e.g. one prefetched on hover) mustn't reset the scroll of this one
	if (!isForPage(url)) return;
	cancelRevalidate?.();
	cancelRevalidate = safeTimeout(
		unloads,
		() => {
			const router = getRouter();
			if (router?.state.navigation.state === "idle") router.revalidate();
		},
		300,
	);
});

// Pages like artist fetch their data from components (RTK Query hooks), not route loaders, so a loader prefetch misses it.
// Learn the queries each route path makes, with its id params as placeholders, and replay them for a hovered link of that path.
type RtkApi = { reducerPath: string; util: { prefetch(endpoint: string, args: unknown, opts: { ifOlderThan: number }): unknown } };
type RtkQueryState = { endpointName: string; originalArgs: unknown; startedTimeStamp?: number };
type QueryTemplate = { api: string; endpoint: string; args: unknown };
const paramMark = "$lunaParam";
// Persisted so hovers prefetch from the start of a session, not only after visiting a page of the same kind
let pageQueries: Record<string, QueryTemplate[]> = {};
ReactiveStore.getStore("@luna/lib")
	.getReactive<Record<string, QueryTemplate[]>>("pageQueries")
	.then((stored) => (pageQueries = stored));
/** Route params naming an item, slugs and view names have no digit */
const idParams = (params: Record<string, string>) => Object.entries(params).filter(([key, value]) => key !== "*" && /\d/.test(value));
const mapArgs = (value: unknown, map: (value: unknown) => unknown | undefined): unknown => {
	const mapped = map(value);
	if (mapped !== undefined) return mapped;
	if (Array.isArray(value)) return value.map((item) => mapArgs(item, map));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapArgs(item, map)]));
	return value;
};
const learnPageQueries = (router: DataRouter) => {
	let cancelLearn: (() => void) | undefined;
	let learnedPath = "";
	unloads.add(
		router.subscribe(({ location: { pathname } }) => {
			if (pathname === learnedPath) return;
			learnedPath = pathname;
			cancelLearn?.();
			const match = matchRoutes(router, pathname);
			if (match === undefined) return;
			const ids = idParams(match.params);
			if (ids.length === 0) return;
			const since = Date.now();
			// Components mount and query within a few seconds of the location changing
			cancelLearn = safeTimeout(
				unloads,
				() => {
					if (location.pathname !== pathname) return;
					const learned: QueryTemplate[] = [];
					const state = <Record<string, { queries?: Record<string, RtkQueryState>; config?: unknown }>>(<unknown>redux.store.getState());
					for (const [api, slice] of Object.entries(state)) {
						if (slice?.queries === undefined || slice.config === undefined) continue;
						for (const query of Object.values(slice.queries)) {
							if ((query?.startedTimeStamp ?? 0) < since) continue;
							let usesParam = false;
							const args = mapArgs(query.originalArgs, (value) => {
								const param = ids.find(([, id]) => String(value) === id);
								if (param === undefined) return;
								usesParam = true;
								return { [paramMark]: param[0], number: typeof value === "number" };
							});
							if (usesParam) learned.push({ api, endpoint: query.endpointName, args });
						}
					}
					// Merged, a visit doesn't re-query what RTK still has cached
					const known = pageQueries[match.path] ?? [];
					const keys = new Set(known.map((query) => JSON.stringify(query)));
					const added = learned.filter((query) => !keys.has(JSON.stringify(query)));
					// shortcut: grows with every distinct query a path makes, capped at 20, add expiry if TIDAL's args churn
					if (added.length !== 0) pageQueries[match.path] = [...known, ...added].slice(-20);
				},
				3000,
			);
		}),
	);
};
const rtkApis = new Map<string, RtkApi>();
const getRtkApi = (reducerPath: string) => {
	if (!rtkApis.has(reducerPath)) {
		const isApi = (_: unknown, value: unknown) =>
			typeof (<RtkApi>value)?.reducerPath === "string" &&
			typeof (<RtkApi>value).util?.prefetch === "function" &&
			!rtkApis.has((<RtkApi>value).reducerPath);
		for (const { value } of recursiveSearch<RtkApi>(tidalModules, isApi)) {
			rtkApis.set(value.reducerPath, value);
			if (value.reducerPath === reducerPath) break;
		}
	}
	return rtkApis.get(reducerPath);
};
const prefetchQueries = (path: string, params: Record<string, string>) => {
	for (const { api, endpoint, args } of pageQueries[path] ?? []) {
		const rtkApi = getRtkApi(api);
		if (rtkApi === undefined) continue;
		const filled = mapArgs(args, (value) => {
			const param = (<Record<string, unknown>>value)?.[paramMark];
			if (typeof param !== "string") return;
			return (<{ number: boolean }>value).number ? Number(params[param]) : params[param];
		});
		// Data newer than a minute is left alone, RTK keeps the result for the page's hook to pick up
		redux.store.dispatch(<never>rtkApi.util.prefetch(endpoint, filled, { ifOlderThan: 60 }));
	}
};

// Prefetch a page when its link is hovered by running TIDAL's own loader for it, which fills the cache, RTK and the store
// A count, prefetches overlap when the pointer moves over several links
let prefetching = 0;
const prefetch = async (href: string) => {
	const router = getRouter();
	if (router === undefined) return libTrace.warn("navigation: TIDAL's router not found, not prefetching");
	const url = new URL(href, location.origin);
	const match = matchRoutes(router, url.pathname);
	if (match === undefined) return;
	prefetching++;
	try {
		prefetchQueries(match.path, match.params);
		await Promise.all(
			match.routes.map(async (route) => {
				// lazy loads the route's code, React Router reuses the module when navigating
				const loader = route.loader ?? (await route.lazy?.())?.loader;
				await loader?.({ params: match.params, request: new Request(url) });
			}),
		);
	} catch {
		// Errors (and redirects) are the real navigation's to handle
	} finally {
		prefetching--;
	}
};
// Load every page's code while idle, so a first visit doesn't wait on fetching and compiling it
// Payment and sign in pages may load third party scripts when imported, they load when visited
const noPreload = /stripe|square|oauth|login|checkout|lastfm/i;
let preloadUnloaded = false;
let preloadingChunk = false;
unloads.add(() => (preloadUnloaded = true));
const idle = () => new Promise((resolve) => requestIdleCallback(resolve, { timeout: 1000 }));
const preloadPages = async (attempt = 0) => {
	const router = getRouter();
	if (router === undefined) {
		// TIDAL renders its router after Luna loads
		if (attempt < 30) safeTimeout(unloads, () => preloadPages(attempt + 1), 1000);
		else libTrace.warn("navigation: TIDAL's router not found, not preloading pages");
		return;
	}
	learnPageQueries(router);
	const routes: DataRoute[] = router.routes.slice();
	for (let i = 0; i < routes.length; i++) {
		const route = routes[i];
		if (route.children !== undefined) for (const child of route.children) routes.push(child);
		if (route.lazy === undefined || noPreload.test(route.path ?? "")) continue;
		await idle();
		if (preloadUnloaded) return;
		if (isOffline) continue;
		preloadingChunk = true;
		try {
			// React Router reuses the loaded module when navigating
			await route.lazy();
		} catch {
			// The real navigation's to handle
		} finally {
			preloadingChunk = false;
		}
	}
};
preloadPages();

let lastMissPath = "";
let lastMissAt = 0;
ipcRenderer.on(unloads, "__Luna.offlineMiss", (url: string) => {
	if (prefetching !== 0 || preloadingChunk || url.includes("/playbackinfo")) return;
	const router = getRouter();
	const targetPath = router?.state.navigation.location?.pathname ?? location.pathname;
	const isChunkMiss = router?.state.navigation.state === "loading" && url.endsWith(".js");
	if (!isChunkMiss && !isForPage(url, targetPath)) return;
	const now = Date.now();
	if (targetPath === lastMissPath && now - lastMissAt < 2000) return;
	lastMissPath = targetPath;
	lastMissAt = now;
	Messager.Warn("Offline — this page is not in the cache");
});

// TIDAL's playlist loader sets the displayed page (and logs it as viewed), not something a prefetch should do
redux.intercept("page/SET_PAGE_ID", unloads, () => prefetching !== 0 && getRouter()?.state.navigation.state === "idle");

const hoverDelayMs = 65;
const prefetchedAt = new Map<string, number>();
let hovered: Element | null = null;
let cancelHover: (() => void) | undefined;
const onPointerOver = (event: PointerEvent) => {
	if (isOffline) return;
	const link = (<Element>event.target).closest?.(`a[href^="/"]`) ?? null;
	if (link === hovered) return;
	hovered = link;
	cancelHover?.();
	const href = link?.getAttribute("href");
	if (!href) return;
	cancelHover = safeTimeout(
		unloads,
		() => {
			if (href === location.pathname + location.search || Date.now() - (prefetchedAt.get(href) ?? 0) < 60_000) return;
			if (prefetchedAt.size > 500) prefetchedAt.clear();
			prefetchedAt.set(href, Date.now());
			prefetch(href);
		},
		hoverDelayMs,
	);
};
document.addEventListener("pointerover", onPointerOver);
unloads.add(() => document.removeEventListener("pointerover", onPointerOver));
