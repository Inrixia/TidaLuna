import { findModuleProperty } from "@luna/core";

export type RouteLoader = (args: { params: Record<string, string>; request: Request; context?: unknown }) => unknown;
export type DataRoute = {
	id: string;
	path?: string;
	children?: DataRoute[];
	loader?: RouteLoader;
	lazy?: () => Promise<{ loader?: RouteLoader }>;
};
/** The parts of TIDAL's React Router data router (`createBrowserRouter`) Luna uses */
export type DataRouter = {
	routes: DataRoute[];
	/** Every route path with the routes it renders (parents first), flattened and ranked by React Router */
	branches: { path: string; routesMeta: { route: DataRoute }[] }[];
	state: { location: { pathname: string; search: string }; navigation: { state: "idle" | "loading" | "submitting" } };
	navigate(to: string): Promise<void>;
	revalidate(): Promise<void>;
	subscribe(listener: (state: DataRouter["state"]) => void): () => void;
};

type Fiber = { memoizedProps?: { router?: Partial<DataRouter> }; child?: Fiber | null; sibling?: Fiber | null };
let router: DataRouter | undefined;
/** TIDAL's router, found in the props of its `RouterProvider` near the top of the React tree. `undefined` before TIDAL renders */
export const getRouter = (): DataRouter | undefined => {
	if (router !== undefined) return router;
	for (const element of document.querySelectorAll("body > *, body > * > *")) {
		const containerKey = Object.keys(element).find((key) => key.startsWith("__reactContainer$"));
		if (containerKey === undefined) continue;
		const stack = [(<Record<string, Fiber>>(<unknown>element))[containerKey]];
		for (let visited = 0; stack.length !== 0 && visited < 10000; visited++) {
			const fiber = stack.pop()!;
			const candidate = fiber.memoizedProps?.router;
			if (typeof candidate?.navigate === "function" && typeof candidate.revalidate === "function" && Array.isArray(candidate.branches)) {
				return (router = <DataRouter>candidate);
			}
			if (fiber.sibling) stack.push(fiber.sibling);
			if (fiber.child) stack.push(fiber.child);
		}
	}
};

type MatchPath = (
	pattern: { path: string; caseSensitive: boolean; end: boolean },
	pathname: string,
) => { params: Record<string, string> } | null;
// React Router's matchPath (TIDAL's bundle exports it, not matchRoutes), known by the pattern it defaults a string to
const isMatchPath = (_: unknown, value: unknown) => typeof value === "function" && /\{path:\w+,caseSensitive:/.test(String(value));

/** The routes (parents first) and params React Router renders for `pathname`, `undefined` if none match */
export const matchRoutes = (router: DataRouter, pathname: string) => {
	const matchPath = findModuleProperty<MatchPath>(isMatchPath)?.value;
	if (matchPath === undefined) return;
	// The same walk as React Router's matchRoutes, branches are in rank order
	for (const branch of router.branches) {
		const match = matchPath({ path: branch.path, caseSensitive: false, end: true }, pathname);
		if (match !== null) return { routes: branch.routesMeta.map((meta) => meta.route), params: match.params };
	}
};
