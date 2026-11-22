import quartz, { type QuartzPlugin } from "@uwu/quartz";

// Ensure patchAction is loaded on window!
import "./exposeTidalInternals.patchAction";

import { resolveAbsolutePath } from "./helpers/resolvePath";

import { findCreateActionFunction } from "./helpers/findCreateAction";
import { getOrCreateLoadingContainer } from "./loadingContainer";
import { applyTidalPatches } from "./tidalPatches";

export const tidalModules: Record<string, object> = {};

// Store pending promises to avoid race conditions with circular imports
const pendingModules: Record<string, Promise<object>> = {};

const fetchCode = async (path: string) => {
	const res = await fetch(path);
	// Include sourceURL so that dev tools shows things nicely under sources
	return `${await res.text()}\n//# sourceURL=${path}`;
};

// Quartz resolves a module's imports one after another, so their code is fetched ahead of time
const prefetchedCode = new Map<string, Promise<string>>();
const prefetchCode = (path: string) => {
	if (tidalModules[path] || path in pendingModules || prefetchedCode.has(path)) return;
	const fetching = fetchCode(path);
	fetching.catch(() => prefetchedCode.delete(path));
	prefetchedCode.set(path, fetching);
};
const takeCode = (path: string) => {
	const prefetched = prefetchedCode.get(path);
	prefetchedCode.delete(path);
	return prefetched?.catch(() => fetchCode(path)) ?? fetchCode(path);
};
const staticImport = /(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+)["']/g;
const prefetchImports = (path: string, code: string) => {
	for (const match of code.matchAll(staticImport)) prefetchCode(resolveAbsolutePath(path, match[1]));
};

// Vite preloads a chunk's dependencies with <link rel="modulepreload">, useless to quartz which runs modules from blobs.
// Fetch them for quartz instead (all at once), rather than the browser fetching and compiling them for nothing
const linkHref = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "href")!;
Object.defineProperty(HTMLLinkElement.prototype, "href", {
	...linkHref,
	set(this: HTMLLinkElement, href: string) {
		if (this.rel === "modulepreload") {
			const url = new URL(href, location.href);
			if (url.origin === location.origin) {
				this.rel = "luna-modulepreload";
				prefetchCode(url.pathname);
			}
		}
		linkHref.set!.call(this, href);
	},
});

let loading = 0;
const { loadingContainer, messageContainer } = getOrCreateLoadingContainer();

const dynamicResolve: QuartzPlugin["dynamicResolve"] = async ({ name, moduleId, config }) => {
	const path = resolveAbsolutePath(moduleId, name);

	// Return cached module if available
	if (tidalModules[path]) return tidalModules[path];

	// If already loading, wait for the same promise instead of reloading
	if (path in pendingModules) return pendingModules[path];

	// Appended, reading innerText forces a layout on every module load
	messageContainer.append(`Loading ${path}`, document.createElement("br"));
	loading++;

	// Create and store the promise BEFORE starting the async work
	const loadPromise = (async () => {
		const code = await takeCode(path);
		prefetchImports(path, code);
		// Load each js module and store it in the cache so we can access its exports
		const module = await quartz(code, config, path);
		tidalModules[path] = module;
		return module;
	})();
	pendingModules[path] = loadPromise;

	const result = await loadPromise;
	loading--;

	delete pendingModules[path];
	setTimeout(() => (loadingContainer.style.opacity = "0"), 2000);
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
// So dw about blocking for loop, their code is fetched all at once
for (const script of scripts) prefetchCode(new URL(script.src).pathname);
for (const script of scripts) {
	const scriptPath = new URL(script.src).pathname;

	const scriptContent = await takeCode(scriptPath);
	prefetchImports(scriptPath, scriptContent);

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
							// Tidal react-dom/client
							const createRootExport = /([\w$]+)\.createRoot\s*=(?!=)/;
							code = code.replace(createRootExport, "$1.createRoot=globalThis.__lunaCreateRoot=");
							code = applyTidalPatches(code);

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
