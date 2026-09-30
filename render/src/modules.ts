import type { Store } from "redux";
import { tidalModules } from "./exposeTidalInternals";
import { findModuleByProperty } from "./helpers/findModule";
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
const resolveCjsModule = (validator: (result: any) => boolean, pathPattern = /.*/) => {
	for (const [path, mod] of Object.entries(tidalModules)) {
		// Fallback pattern catches everything if paths are obfuscated
		if (!pathPattern.test(path)) continue;

		for (const value of Object.values(mod)) {
			if (typeof value !== "function") continue;

			const src = Function.prototype.toString.call(value);
			// Broadened check: only ensures it touches module exports in some capacity
			if (!src.includes("exports")) continue;

			try {
				// Attempt to execute the thunk
				const result = value();
				if (result && typeof result === "object" && validator(result)) {
					return result;
				}
			} catch (err) {
				// If it fails, it's either not a no-arg thunk or it's the wrong module.
				// Keep iterating.
			}
		}
	}
	return null;
};

// Expose react
const react = resolveCjsModule((r) => typeof r.useState === "function" && typeof r.useEffect === "function");

if (react) {
	react.default ??= react;
	modules["react"] = react;
} else {
	coreTrace.warn("modules", "Failed to resolve React module");
}

const jsxRT = resolveCjsModule((r) => typeof r.jsx === "function" && typeof r.jsxs === "function");
if (jsxRT) {
	jsxRT.default ??= jsxRT;
	modules["react/jsx-runtime"] = jsxRT;
} else {
	coreTrace.warn("modules", "Failed to resolve react/jsx-runtime module");
}

// Tidal tree shakes hydrateRoot
const reactDom = resolveCjsModule((r) => typeof r.createRoot === "function");

// Fallback for react-dom/client
const taggedCreateRoot = (<any>globalThis).__lunaCreateRoot;

if (reactDom) {
	reactDom.default ??= reactDom;
	modules["react-dom/client"] = reactDom;
} else if (typeof taggedCreateRoot === "function") {
	const client: any = { createRoot: taggedCreateRoot };
	client.default = client;
	modules["react-dom/client"] = client;
} else {
	coreTrace.warn("modules", "Failed to resolve react-dom/client module");
}

modules["oby"] = await import("oby");
