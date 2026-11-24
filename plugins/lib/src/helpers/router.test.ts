import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { DataRoute, DataRouter } from "./router";

/**
 * `getRouter` caches the router it walks the React tree for, and `matchRoutes` looks React Router's `matchPath` up
 * through the memoized `findModuleProperty`. Both caches live in module scope, so every test imports a fresh copy of
 * the helper (and so a fresh, empty `tidalModules`) and seeds what that lookup needs before calling in.
 */
const load = async (modules: Record<string, object> = {}) => {
	vi.resetModules();
	const { tidalModules } = await import("@luna/core");
	Object.assign(tidalModules, modules);
	return import("./router");
};

type Fiber = { memoizedProps?: { router?: unknown }; child?: Fiber | null; sibling?: Fiber | null };

/** React stores the root fiber of a mounted tree under a `__reactContainer$<random>` key on the container element */
let mountCount = 0;
const mountReactTree = (root: Fiber) => {
	const container = document.createElement("div");
	container.id = `luna-router-root-${mountCount++}`;
	(container as unknown as Record<string, Fiber>)[`__reactContainer$${container.id}`] = root;
	document.body.appendChild(container);
	return container;
};

const dataRouter = (overrides: Partial<DataRouter> = {}): DataRouter => ({
	routes: [],
	branches: [],
	state: { location: { pathname: "/", search: "" }, navigation: { state: "idle" } },
	navigate: vi.fn(async () => {}),
	revalidate: vi.fn(async () => {}),
	subscribe: vi.fn(() => () => {}),
	...overrides,
});

beforeEach(() => {
	document.body.innerHTML = "";
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("getRouter", () => {
	test("is undefined while TIDAL has mounted no router", async () => {
		const { getRouter } = await load();
		document.body.appendChild(document.createElement("div"));
		// A React container whose fibers carry other props is not a router either
		mountReactTree({ memoizedProps: {}, child: { memoizedProps: {} } });

		expect(getRouter()).toBeUndefined();
	});

	test("finds the router in the props of a fiber in the React tree", async () => {
		const { getRouter } = await load();
		const router = dataRouter();
		mountReactTree({ memoizedProps: {}, child: { memoizedProps: { router } } });

		expect(getRouter()).toBe(router);
	});

	test("walks child and sibling fibers", async () => {
		const { getRouter } = await load();
		const router = dataRouter();
		// The router is on the sibling of the root's first child, two levels down
		mountReactTree({ memoizedProps: {}, child: { memoizedProps: {}, sibling: { memoizedProps: {}, child: { memoizedProps: { router } } } } });

		expect(getRouter()).toBe(router);
	});

	test("skips props that are not a data router", async () => {
		const { getRouter } = await load();
		const router = dataRouter();
		const lookAlikes: Fiber[] = [
			// No navigate/revalidate
			{ memoizedProps: { router: { branches: [] } } },
			// branches isn't a list
			{ memoizedProps: { router: { navigate() {}, revalidate: async () => {}, branches: "not-an-array" } } },
		];
		for (const lookAlike of lookAlikes) mountReactTree(lookAlike);
		mountReactTree({ memoizedProps: { router } });

		expect(getRouter()).toBe(router);
	});

	test("finds a container that isn't a direct child of body", async () => {
		const { getRouter } = await load();
		const router = dataRouter();
		const wrapper = document.createElement("main");
		document.body.appendChild(wrapper);
		const container = document.createElement("div");
		(container as unknown as Record<string, Fiber>)["__reactContainer$nested"] = { memoizedProps: { router } };
		wrapper.appendChild(container);

		expect(getRouter()).toBe(router);
	});

	test("keeps the router it found when the page renders again", async () => {
		const { getRouter } = await load();
		const router = dataRouter();
		mountReactTree({ memoizedProps: { router } });
		expect(getRouter()).toBe(router);

		// TIDAL re-rendering replaces the container, the helper doesn't walk the tree again
		document.body.innerHTML = "";
		const reRendered = dataRouter();
		mountReactTree({ memoizedProps: { router: reRendered } });

		expect(getRouter()).toBe(router);
	});
});

type MatchPathPattern = { path: string; caseSensitive: boolean; end: boolean };
const matchPathCalls: [MatchPathPattern, string][] = [];

/**
 * A stand-in for React Router's `matchPath`, which TIDAL only exports minified: `router.ts` recognises it by the
 * `{path:<ident>,caseSensitive:` in its source, so the source form is overridden here. It matches like React Router
 * for the shapes below (`:param` segments, `end` anchoring) and records the arguments it was given.
 */
const fauxMatchPath = (pattern: MatchPathPattern, pathname: string): { params: Record<string, string> } | null => {
	matchPathCalls.push([pattern, pathname]);
	const patternParts = pattern.path.split("/").filter((part) => part !== "");
	const pathParts = pathname.split("/").filter((part) => part !== "");
	if (patternParts.length !== pathParts.length) return null;
	const params: Record<string, string> = {};
	for (const [index, part] of patternParts.entries()) {
		const actual = pathParts[index];
		if (part.startsWith(":")) {
			params[part.slice(1)] = decodeURIComponent(actual);
			continue;
		}
		const matches = pattern.caseSensitive ? part === actual : part.toLowerCase() === actual.toLowerCase();
		if (!matches) return null;
	}
	return { params };
};
fauxMatchPath.toString = () => "matchPath({path:e,caseSensitive:t,end:n},r){return n?e:(r&&e)}";
const matchPathModule = { "tidal/react-router": { matchPath: fauxMatchPath } };

beforeEach(() => {
	matchPathCalls.length = 0;
});

describe("matchRoutes", () => {
	test("returns the routes of the first branch that matches, with its params", async () => {
		const { matchRoutes } = await load(matchPathModule);
		const albumRoute: DataRoute = { id: "album-route", path: "album/:albumId" };
		const trackRoute: DataRoute = { id: "track-route", path: "track/:trackId" };
		const router = dataRouter({
			branches: [
				// Branches come ranked, most specific first
				{ path: "album/:albumId/track/:trackId", routesMeta: [{ route: albumRoute }, { route: trackRoute }] },
				{ path: "album/:albumId", routesMeta: [{ route: albumRoute }] },
			],
		});

		expect(matchRoutes(router, "/album/123/track/456")).toEqual({
			path: "album/:albumId/track/:trackId",
			routes: [albumRoute, trackRoute],
			params: { albumId: "123", trackId: "456" },
		});
		// React Router's matchPath takes the whole path pattern, not just the branch path
		expect(matchPathCalls[0]).toEqual([{ path: "album/:albumId/track/:trackId", caseSensitive: false, end: true }, "/album/123/track/456"]);
	});

	test("is undefined when no branch matches", async () => {
		const { matchRoutes } = await load(matchPathModule);
		const route: DataRoute = { id: "album-route", path: "album/:albumId" };
		const router = dataRouter({ branches: [{ path: "album/:albumId", routesMeta: [{ route }] }] });

		// `end: true`, so a path below the branch is not a match
		expect(matchRoutes(router, "/album/123/extra")).toBeUndefined();
		expect(matchRoutes(dataRouter(), "/album/123")).toBeUndefined();
	});

	test("is undefined when TIDAL's matchPath isn't in the modules", async () => {
		const { matchRoutes } = await load();
		const router = dataRouter({ branches: [{ path: "album/:albumId", routesMeta: [{ route: { id: "album" } }] }] });

		expect(matchRoutes(router, "/album/123")).toBeUndefined();
	});

	test("ignores a matchPath look-alike that isn't React Router's", async () => {
		// A function by that name, but its source doesn't have the shape the selector looks for
		const { matchRoutes } = await load({ "tidal/other": { matchPath: (pattern: unknown) => ({ params: {} }) } });
		const router = dataRouter({ branches: [{ path: "album/:albumId", routesMeta: [{ route: { id: "album" } }] }] });

		expect(matchRoutes(router, "/album/123")).toBeUndefined();
	});
});
