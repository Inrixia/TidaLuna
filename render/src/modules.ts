import type { Store } from "redux";
import { findModuleByProperty } from "./helpers/findModule";
import { tidalModules } from "./exposeTidalInternals";
import { coreTrace } from "./trace/Tracer";

export const modules: Record<string, any> = {};

// Define a global require function to use modules for cjs imports bundled with esbuild
window.require = <NodeJS.Require>((moduleName: string) => {
	if (modules.hasOwnProperty(moduleName)) return modules[moduleName];
	throw new Error(`Dynamic require called for '${moduleName}' does not exist in core.modules!`);
});
window.require.cache = modules;
window.require.main = undefined;

export const reduxStore: Store = findModuleByProperty((key, value) => key === "replaceReducer" && typeof value === "function")!;

// Tidal's bundler wraps CJS modules (React, ReactDOM, jsx-runtime) in lazy loaders
// and minifies export names. Find the chunk by path, invoke the lazy loader, validate the result.
const resolveCjsModule = (pathPattern: RegExp, validator: (r: any) => boolean) => {
	for (const [path, mod] of Object.entries(tidalModules)) {
		if (!pathPattern.test(path)) continue;
		for (const value of Object.values(mod)) {
			if (typeof value !== "function") continue;
			const src = Function.prototype.toString.call(value);
			if (!src.includes("{exports:{}") || !src.includes(".exports")) continue;
			try {
				const result = value();
				if (result && typeof result === "object" && validator(result)) return result;
			} catch {}
		}
	}
};

// Expose react
const react = resolveCjsModule(/\/react-(?!dom[-.])[^/]+\.js$/, (r) => typeof r.useState === "function" && typeof r.useEffect === "function");
if (react) { react.default ??= react; modules["react"] = react; }
else { coreTrace.warn("modules", "Failed to resolve React module"); }

const jsxRT = resolveCjsModule(/\/jsx-runtime-[^/]+\.js$/, (r) => typeof r.jsx === "function" && typeof r.jsxs === "function");
if (jsxRT) { jsxRT.default ??= jsxRT; modules["react/jsx-runtime"] = jsxRT; }
else { coreTrace.warn("modules", "Failed to resolve react/jsx-runtime module"); }

const reactDom = resolveCjsModule(/\/react-dom-[^/]+\.js$/, (r) => typeof r.createRoot === "function" && typeof r.hydrateRoot === "function");
if (reactDom) { reactDom.default ??= reactDom; modules["react-dom/client"] = reactDom; }
else { coreTrace.warn("modules", "Failed to resolve react-dom/client module"); }

modules["oby"] = await import("oby");
