import quartz, { type QuartzPlugin } from "@uwu/quartz";

// Ensure patchAction is loaded on window!
import "./exposeTidalInternals.patchAction";

import { resolveAbsolutePath } from "./helpers/resolvePath";

import { findCreateActionFunction } from "./helpers/findCreateAction";
import { getOrCreateLoadingContainer } from "./loadingContainer";

export const tidalModules: Record<string, object> = {};

// Store pending promises to avoid race conditions with circular imports
const pendingModules: Record<string, Promise<object>> = {};

const fetchCode = async (path: string) => {
	const res = await fetch(path);
	// Include sourceURL so that dev tools shows things nicely under sources
	return `${await res.text()}\n//# sourceURL=${path}`;
};

let loading = 0;
const messageContainer = getOrCreateLoadingContainer().messageContainer;

const dynamicResolve: QuartzPlugin["dynamicResolve"] = async ({ name, moduleId, config }) => {
	const path = resolveAbsolutePath(moduleId, name);

	// Return cached module if available
	if (tidalModules[path]) return tidalModules[path];

	// If already loading, wait for the same promise instead of reloading
	if (pendingModules[path]) return pendingModules[path];

	messageContainer.innerText += `Loading ${path}\n`;
	loading++;

	// Create and store the promise BEFORE starting the async work
	const loadPromise = (async () => {
		const code = await fetchCode(path);
		// Load each js module and store it in the cache so we can access its exports
		const module = await quartz(code, config, path);
		tidalModules[path] = module;
		return module;
	})();
	pendingModules[path] = loadPromise;

	const result = await loadPromise;
	loading--;

	delete pendingModules[path];
	setTimeout(() => (document.getElementById("tidaluna-loading")!.style.opacity = "0"), 2000);
	return result;
};

// Async wait for quartz scripts to be in DOM (needed for tidal-hifi where preload runs before HTML loads)
const waitForScripts = (): Promise<NodeListOf<HTMLScriptElement>> => {
	return new Promise((resolve) => {
		const checkScripts = () => {
			const scripts = document.querySelectorAll<HTMLScriptElement>(`script[type="luna/quartz"]`);
			return scripts.length >= 1 ? scripts : null;
		};
		const setupObserver = () => {
			const observer = new MutationObserver(() => {
				const scripts = checkScripts();
				if (scripts) {
					observer.disconnect();
					resolve(scripts);
				}
			});
			observer.observe(document.documentElement, { childList: true, subtree: true });
		};
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", () => {
				const scripts = checkScripts();
				scripts ? resolve(scripts) : setupObserver();
			});
		} else {
			const scripts = checkScripts();
			scripts ? resolve(scripts) : setupObserver();
		}
	});
};

messageContainer.innerText = "Waiting for tidal scripts to load...\n";
const scripts = await waitForScripts();

// Theres usually only 1 script on page that needs injecting (https://desktop.tidal.com/) see native/injector
// So dw about blocking for loop
for (const script of scripts) {
	const scriptPath = new URL(script.src).pathname;

	const scriptContent = await fetchCode(scriptPath);

	// Create and store the promise BEFORE executing quartz to prevent race conditions
	// This ensures that if dynamicResolve is called for this module during execution,
	// it will wait for this same promise instead of loading the module again
	const loadPromise = (async () => {
		const module = await quartz(
			scriptContent,
			{
				// Quartz runs transform > dynamicResolve > resolve
				plugins: [
					{
						transform({ code }) {
							const actionData = findCreateActionFunction(code);

							if (actionData) {
								const { fnName, startIdx } = actionData;
								const funcPrefix = "__LunaUnpatched_";
								const renamedFn = funcPrefix + fnName;

								// Rename the original function declaration by adding a prefix
								// Example: `prepareAction` becomes `__LunaUnpatched_prepareAction`
								code = code.slice(0, startIdx) + funcPrefix + code.slice(startIdx);

								// Assuming the declaration starts 9 characters before the function name
								// (e.g., accounting for "const " or "function ")
								const declarationStartIdx = startIdx - 9;
								const patchedDeclaration = `const ${fnName} = patchAction({ _: ${renamedFn} })._;`;

								// Insert the new patched declaration before the original (now renamed) one
								code = code.slice(0, declarationStartIdx) + patchedDeclaration + code.slice(declarationStartIdx);
							}

							return code;
						},
						dynamicResolve,
						async resolve({ name, moduleId, config, accessor, store }) {
							(store as any).exports = await dynamicResolve({ name, moduleId, config });
							return `${accessor}.exports`;
						},
					},
				],
			},
			scriptPath,
		);
		tidalModules[scriptPath] = module;
		return module;
	})();

	// Store the promise BEFORE awaiting it
	pendingModules[scriptPath] = loadPromise;

	// Fetch, transform execute and store the module in moduleCache
	// Hijack the Redux store & inject interceptors
	await loadPromise;

	delete pendingModules[scriptPath];
}
