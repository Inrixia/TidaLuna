import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import { resetTidalState, setTidalState, type TidalState } from "../../../test/harness/tidalStore";

import type { DataRoute, DataRouter } from "./helpers/router";

/**
 * `navigation.ts` is a side effect module: importing it registers the request cache rules and interceptors, listens for
 * the main process' messages and prefetches/preloads TIDAL's pages. Its module state (the router it found, the hover
 * dates, whether it is offline) lives for the file, so the tests below build on each other in order.
 */

// #region Fetch, location and IPC stubs
// requestCache captures `globalThis.fetch` when it is first imported, so the server has to be in place before any import
// of @luna/core. `navigation.ts` is imported dynamically after it, and derives page urls from `location`.
const bodies = new Map<string, string>();
const requests: string[] = [];
const realFetch = globalThis.fetch;
const realLocation = globalThis.location;

const setPath = (pathname: string) => {
	(<{ location: unknown }>(<unknown>globalThis)).location = {
		origin: "https://desktop.tidal.com",
		href: `https://desktop.tidal.com${pathname}`,
		pathname,
		search: "",
		hash: "",
	};
};
setPath("/album/123");

(<{ fetch: typeof fetch }>(<unknown>globalThis)).fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
	const body = bodies.get(url.pathname);
	return body === undefined ? new Response("", { status: 404 }) : new Response(body, { headers: { "content-type": "application/json" } });
};

/** The listeners `navigation.ts` subscribed with the preload's ipcRenderer, so a test can send it a main process message */
type IpcListener = (...args: unknown[]) => unknown;
const ipcListeners = new Map<string, Set<IpcListener>>();
const ipcRenderer = (<{ __ipcRenderer: { on: (channel: string, listener: IpcListener) => () => void } }>(<unknown>globalThis)).__ipcRenderer;
const realIpcOn = ipcRenderer.on;
ipcRenderer.on = (channel, listener) => {
	const listeners = ipcListeners.get(channel) ?? new Set();
	ipcListeners.set(channel, listeners);
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const emitIpc = (channel: string, ...args: unknown[]) => {
	for (const listener of ipcListeners.get(channel) ?? []) listener(...args);
};

vi.useFakeTimers();

const { interceptors, Messager, requestCache, tidalModules } = await import("@luna/core");

/** TIDAL's minified React Router `matchPath`: the helper recognises it by its source, which is faked here (see router.test.ts) */
type MatchPathPattern = { path: string; caseSensitive: boolean; end: boolean };
const matchPathCalls: [MatchPathPattern, string][] = [];
const fauxMatchPath = (pattern: MatchPathPattern, pathname: string): { params: Record<string, string> } | null => {
	matchPathCalls.push([pattern, pathname]);
	const patternParts = pattern.path.split("/").filter((part) => part !== "");
	const pathParts = pathname.split("/").filter((part) => part !== "");
	if (patternParts.length !== pathParts.length) return null;
	const params: Record<string, string> = {};
	for (const [index, part] of patternParts.entries()) {
		const actual = pathParts[index]!;
		if (part.startsWith(":")) {
			params[part.slice(1)] = decodeURIComponent(actual);
			continue;
		}
		if (part.toLowerCase() !== actual.toLowerCase()) return null;
	}
	return { params };
};
fauxMatchPath.toString = () => "matchPath({path:e,caseSensitive:t,end:n},r){return n?e:(r&&e)}";
Object.assign(tidalModules, { "tidal/react-router": { matchPath: fauxMatchPath } });
// #endregion

// Imported for its side effects: the cache rules, interceptors, listeners and the prefetch/preload machinery
await import("./navigation");
const { unloads } = await import("./index.safe");

// #region Router fixture
const navigate = vi.fn(async () => {});
const revalidate = vi.fn(async () => {});
/** The listener `navigation.ts` learns the queries of each page path with, captured when it subscribes to the router */
let onLocationChange: ((state: DataRouter["state"]) => void) | undefined;
const router: DataRouter = {
	routes: [],
	branches: [],
	state: { location: { pathname: "/", search: "" }, navigation: { state: "idle" } },
	navigate,
	revalidate,
	subscribe: vi.fn((listener: (state: DataRouter["state"]) => void) => {
		onLocationChange = listener;
		return () => {};
	}),
};
/** React stores the root fiber of a mounted tree under a `__reactContainer$<random>` key on the container element */
const reactRoot = document.createElement("div");
(<Record<string, unknown>>(<unknown>reactRoot))["__reactContainer$navigation-test"] = { memoizedProps: { router } };
document.body.appendChild(reactRoot);

type LoaderArgs = { params: Record<string, string>; request: Request };
const loader = (impl: (args: LoaderArgs) => unknown = () => {}) => vi.fn((args: LoaderArgs) => impl(args));
const branchFor = (path: string, route: DataRoute) => ({ path, routesMeta: [{ route }] });

const linkTo = (href: string) => {
	const link = document.createElement("a");
	link.setAttribute("href", href);
	document.body.append(link);
	return link;
};
const hover = (link: Element) => link.dispatchEvent(new Event("pointerover", { bubbles: true }));
/** Moving the pointer off the links: a pointerover over something that isn't a link */
const unhover = () => document.body.dispatchEvent(new Event("pointerover", { bubbles: true }));
// #endregion

/** happy-dom delivers mutation records and promise continuations in microtasks, this is what makes them have run */
const flush = () => vi.advanceTimersByTimeAsync(1);
const hoverDelay = () => vi.advanceTimersByTimeAsync(65);

const runInterceptors = (type: string, payload: unknown) => {
	const registered = (<Record<string, Set<(payload: unknown, type: string) => unknown>>>(<unknown>interceptors))[type];
	for (const interceptor of registered ?? []) if (interceptor(payload, type) === true) return true;
	return false;
};

const json = (path: string, value: unknown) => bodies.set(path, JSON.stringify(value));

beforeEach(() => {
	requests.length = 0;
	matchPathCalls.length = 0;
	router.branches = [];
	router.state.navigation = { state: "idle" };
	navigate.mockClear();
	revalidate.mockClear();
	for (const link of document.querySelectorAll("a")) link.remove();
});

afterAll(() => {
	globalThis.fetch = realFetch;
	globalThis.location = realLocation;
	ipcRenderer.on = realIpcOn;
	vi.useRealTimers();
});

describe("the request cache", () => {
	test("answers TIDAL's page requests from the cache", async () => {
		const pages: [path: string, api: string, touched: string][] = [
			["/v1/albums/1001", "https://api.tidal.com/v1/albums/1001", "https://desktop.tidal.com/v1/albums/1001"],
			[
				"/v1/users/7/favorites/tracks",
				"https://api.tidal.com/v1/users/7/favorites/tracks",
				"https://desktop.tidal.com/v1/users/7/favorites/tracks",
			],
			["/v2/artist/1002", "https://api.tidal.com/v2/artist/1002", "https://desktop.tidal.com/v2/artist/1002"],
			["/v2/playlists/1003", "https://openapi.tidal.com/v2/playlists/1003", "https://openapi.tidal.com/v2/playlists/1003"],
		];

		for (const [page, api, touched] of pages) {
			json(page, { page });
			expect(await (await fetch(api)).json()).toEqual({ page });
			// desktop. and api. are the same api: the second url is answered from the first one's entry
			const second = await fetch(touched);
			expect(await second.json()).toEqual({ page });
		}

		// One request per page, every other fetch was served from the cache
		expect(requests.length).toBe(pages.length);
	});

	test("fetches a url no rule covers every time", async () => {
		json("/v1/tracks/1004", { track: 1004 });
		await fetch("https://api.tidal.com/v1/tracks/1004");
		await fetch("https://api.tidal.com/v1/tracks/1004");

		await fetch("https://cdn.example/track-1004.flac");
		await fetch("https://cdn.example/track-1004.flac");

		expect(requests).toEqual(["GET /v1/tracks/1004", "GET /v1/tracks/1004", "GET /track-1004.flac", "GET /track-1004.flac"]);
	});

	test("clears the cache when the session logs out", async () => {
		json("/v1/albums/1005", { album: 1005 });
		await fetch("https://api.tidal.com/v1/albums/1005");
		expect(requestCache.stats().entries).toBeGreaterThan(0);

		// The logout action is not cancelled, the cache is only dropped
		expect(runInterceptors("session/LOGOUT", undefined)).toBe(false);

		expect(requestCache.stats().entries).toBe(0);
		await fetch("https://api.tidal.com/v1/albums/1005");
		expect(requests).toEqual(["GET /v1/albums/1005", "GET /v1/albums/1005"]);
	});

	test("cancels TIDAL's connection lost action", () => {
		// TIDAL would replace the page with its offline state, Luna serves cached content instead
		expect(runInterceptors("network/CONNECTION_LOST", undefined)).toBe(true);
	});

	test("does not cancel a page being set outside a prefetch", () => {
		expect(runInterceptors("page/SET_PAGE_ID", "1006")).toBe(false);
	});
});

describe("revalidating the page that is open", () => {

	test("does not re-run them for another page's response", async () => {
		setPath("/album/2001");
		json("/v1/albums/2002", { v: 1 });
		const url = "https://api.tidal.com/v1/albums/2002";
		await fetch(url);

		vi.advanceTimersByTime(6_000);
		json("/v1/albums/2002", { v: 2 });
		await fetch(url);
		await flush();
		await vi.advanceTimersByTimeAsync(300);

		expect(revalidate).not.toHaveBeenCalled();
	});
});

describe("prefetching a hovered link", () => {
	test("runs TIDAL's loader for the hovered page", async () => {
		setPath("/album/123");
		const albumLoader = loader();
		router.branches = [branchFor("album/:albumId", { id: "album", path: "album/:albumId", loader: albumLoader })];

		hover(linkTo("/album/3001"));
		await hoverDelay();
		await flush();

		expect(albumLoader).toHaveBeenCalledTimes(1);
		const args = albumLoader.mock.calls[0]![0];
		expect(args.params).toEqual({ albumId: "3001" });
		expect(args.request.url).toBe("https://desktop.tidal.com/album/3001");
		// React Router's matchPath was asked about the hovered pathname
		expect(matchPathCalls[0]![1]).toBe("/album/3001");
	});

	test("lazy loads the route's code and runs the loader it exports", async () => {
		setPath("/album/123");
		const playlistLoader = loader();
		const lazy = vi.fn(async () => ({ loader: playlistLoader }));
		router.branches = [branchFor("playlist/:uuid", { id: "playlist", path: "playlist/:uuid", lazy })];

		hover(linkTo("/playlist/3002"));
		await hoverDelay();
		await flush();

		expect(lazy).toHaveBeenCalledTimes(1);
		expect(playlistLoader).toHaveBeenCalledTimes(1);
		expect(playlistLoader.mock.calls[0]![0].params).toEqual({ uuid: "3002" });
	});

	test("leaves a link to the page that is already open alone", async () => {
		setPath("/album/3003");
		const albumLoader = loader();
		router.branches = [branchFor("album/:albumId", { id: "album", loader: albumLoader })];

		hover(linkTo("/album/3003"));
		await hoverDelay();
		await flush();

		expect(albumLoader).not.toHaveBeenCalled();
	});

	test("leaves a link that matches no route alone", async () => {
		setPath("/album/123");
		const albumLoader = loader();
		router.branches = [branchFor("album/:albumId", { id: "album", loader: albumLoader })];

		hover(linkTo("/nowhere/3005"));
		await hoverDelay();
		await flush();

		expect(albumLoader).not.toHaveBeenCalled();
	});

	test("prefetches a link once", async () => {
		setPath("/album/123");
		const albumLoader = loader();
		router.branches = [branchFor("album/:albumId", { id: "album", loader: albumLoader })];
		const link = linkTo("/album/3004");

		hover(link);
		await hoverDelay();
		await flush();
		unhover();
		hover(link);
		await hoverDelay();
		await flush();

		expect(albumLoader).toHaveBeenCalledTimes(1);
	});

	test("a loader that throws doesn't break the next prefetch", async () => {
		setPath("/album/123");
		router.branches = [
			branchFor("mix/:mixId", {
				id: "mix",
				loader: () => {
					throw new Error("loader failed");
				},
			}),
		];

		hover(linkTo("/mix/3006"));
		await hoverDelay();
		await flush();

		// The prefetch count is back to zero, so the page's own load may set the page id again
		expect(runInterceptors("page/SET_PAGE_ID", "3006")).toBe(false);
	});

	test("does not let a prefetch set the page id", async () => {
		setPath("/album/123");
		let release = () => {};
		const hanging = new Promise<void>((resolve) => (release = resolve));
		router.branches = [branchFor("artist/:artistId", { id: "artist", loader: () => hanging })];

		hover(linkTo("/artist/3007"));
		await hoverDelay();
		await flush();

		// TIDAL's playlist loader sets the displayed page and logs it as viewed: not something a prefetch should do
		expect(runInterceptors("page/SET_PAGE_ID", "3007")).toBe(true);

		release();
		await flush();
		expect(runInterceptors("page/SET_PAGE_ID", "3007")).toBe(false);
	});

	test("learns the queries a page made and replays them for a hovered link of that path", async () => {
		setPath("/album/3008");
		router.branches = [branchFor("album/:albumId", { id: "album", loader: loader() })];
		// TIDAL's own RTK Query api, found through `tidalModules` by the prefetcher
		const prefetch = vi.fn((endpoint: string, args: unknown) => ({ type: "pageApi/prefetch", endpoint, args }));
		Object.assign(tidalModules, { "tidal/rtk": { pageApi: { reducerPath: "pageApi", util: { prefetch } } } });

		// Pages like artist query their data from components instead of route loaders: the queries a path makes are
		// recorded, with the item's id left as a placeholder
		setTidalState({
			pageApi: {
				config: {},
				queries: { "albumId-3008": { endpointName: "getAlbum", originalArgs: { albumId: 3008 }, startedTimeStamp: Date.now() } },
			},
		} as unknown as Partial<TidalState>);
		expect(onLocationChange).toBeDefined();
		onLocationChange!({ location: { pathname: "/album/3008", search: "" }, navigation: { state: "idle" } });
		// The components have a few seconds after the location change to make their queries
		await vi.advanceTimersByTimeAsync(3000);

		hover(linkTo("/album/3009"));
		await hoverDelay();
		await flush();

		// Prefetched with the query it would make, the id filled in from the link as the number TIDAL queried with
		expect(prefetch).toHaveBeenCalledWith("getAlbum", { albumId: 3009 }, { ifOlderThan: 60 });
		resetTidalState();
	});
});

describe("offline", () => {
	test("stops prefetching while the window reports it is offline", async () => {
		setPath("/album/123");
		const albumLoader = loader();
		router.branches = [branchFor("album/:albumId", { id: "album", loader: albumLoader })];

		window.dispatchEvent(new Event("offline"));
		hover(linkTo("/album/4001"));
		await hoverDelay();
		await flush();
		expect(albumLoader).not.toHaveBeenCalled();

		// The main process says the connection is back
		emitIpc("__Luna.offlineStatus", false);
		hover(linkTo("/album/4002"));
		await hoverDelay();
		await flush();
		expect(albumLoader).toHaveBeenCalledTimes(1);
	});

	test("checks with the network when the window comes back online", async () => {
		emitIpc("__Luna.offlineStatus", true);
		requests.length = 0;

		window.dispatchEvent(new Event("online"));
		await flush();

		expect(requests).toEqual(["GET /v1/ping"]);
		emitIpc("__Luna.offlineStatus", false);
	});

	test("the window's online event does not itself clear the offline state", async () => {
		emitIpc("__Luna.offlineStatus", true);
		setPath("/album/123");
		const albumLoader = loader();
		router.branches = [branchFor("album/:albumId", { id: "album", loader: albumLoader })];

		window.dispatchEvent(new Event("online"));
		await flush();
		hover(linkTo("/album/4003"));
		await hoverDelay();
		await flush();

		// Pinned real behaviour: only the main process' status message clears `isOffline`, so after a network blip that
		// recovered on its own prefetching stays off until TIDAL sends one.
		expect(albumLoader).not.toHaveBeenCalled();
		emitIpc("__Luna.offlineStatus", false);
	});
});

describe("an offline miss", () => {
	test("warns when a page's code chunk could not be loaded", async () => {
		const warn = vi.spyOn(Messager, "Warn");
		router.state.navigation = { state: "loading", location: { pathname: "/album/5001", search: "" } };

		emitIpc("__Luna.offlineMiss", "https://luna/chunk-5001.js");
		expect(warn).toHaveBeenCalledTimes(1);

		// At most one warning every two seconds for the same page
		emitIpc("__Luna.offlineMiss", "https://luna/chunk-5001.js");
		expect(warn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2000);
		emitIpc("__Luna.offlineMiss", "https://luna/chunk-5001.js");
		expect(warn).toHaveBeenCalledTimes(2);

		warn.mockRestore();
		router.state.navigation = { state: "idle" };
	});

	test("does not warn for another page's request", async () => {
		const warn = vi.spyOn(Messager, "Warn");
		setPath("/album/5001");

		emitIpc("__Luna.offlineMiss", "https://api.tidal.com/v1/albums/5002/page");
		await flush();

		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	test("does not warn for a playbackinfo request", async () => {
		const warn = vi.spyOn(Messager, "Warn");
		setPath("/album/5001");

		emitIpc("__Luna.offlineMiss", "https://api.tidal.com/v1/albums/5001/playbackinfo");
		await flush();

		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("unloading", () => {
	test("removes the cache rules, listeners and interceptors it registered", async () => {
		expect(unloads.size).toBeGreaterThan(0);

		for (const unload of [...unloads]) unload();

		// Nothing answers TIDAL's page requests from the cache any more
		json("/v1/albums/6001", { album: 6001 });
		await fetch("https://api.tidal.com/v1/albums/6001");
		await fetch("https://api.tidal.com/v1/albums/6001");
		expect(requests).toEqual(["GET /v1/albums/6001", "GET /v1/albums/6001"]);

		// The window's connectivity listeners are gone
		requests.length = 0;
		window.dispatchEvent(new Event("offline"));
		window.dispatchEvent(new Event("online"));
		await flush();
		expect(requests).toEqual([]);

		// So is the pointerover listener
		setPath("/album/123");
		const albumLoader = loader();
		router.branches = [branchFor("album/:albumId", { id: "album", loader: albumLoader })];
		hover(linkTo("/album/6002"));
		await hoverDelay();
		await flush();
		expect(albumLoader).not.toHaveBeenCalled();

		expect(interceptors["network/CONNECTION_LOST"]).toBeUndefined();
	});
});
