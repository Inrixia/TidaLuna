import type { Store } from "redux";
import { findModuleByProperty } from "./helpers/findModule";

export const modules: Record<string, any> = {};

// Define a global require function to use modules for cjs imports bundled with esbuild
window.require = <NodeJS.Require>((moduleName: string) => {
	if (modules.hasOwnProperty(moduleName)) return modules[moduleName];
	throw new Error(`Dynamic require called for '${moduleName}' does not exist in core.modules!`);
});
window.require.cache = modules;
window.require.main = undefined;

export const reduxStore: Store = findModuleByProperty((key, value) => key === "replaceReducer" && typeof value === "function")!;

// Expose react
modules["react"] = findModuleByProperty((key, value) => key === "createElement" && typeof value === "function");
modules["react"].default ??= modules["react"];

modules["react/jsx-runtime"] = findModuleByProperty((key, value) => key === "jsx" && typeof value === "function");
modules["react/jsx-runtime"].default ??= modules["react/jsx-runtime"];

// Expose react-dom
modules["react-dom/client"] = findModuleByProperty((key, value) => key === "createRoot" && typeof value === "function");
modules["react-dom/client"].default ??= modules["react-dom/client"];

modules["oby"] = await import("oby");
modules["path"] = path;
