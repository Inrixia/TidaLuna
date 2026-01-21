// Always expose internals first
export { tidalModules } from "./exposeTidalInternals";
export { buildActions, interceptors } from "./exposeTidalInternals.patchAction";

export * as ftch from "./helpers/fetch";
export { findModuleByProperty, findModuleProperty, recursiveSearch } from "./helpers/findModule";
export { unloadSet, type LunaUnload, type LunaUnloads, type NullishLunaUnloads } from "./helpers/unloadSet";

export { Messager, Tracer } from "./trace";

export { modules, reduxStore } from "./modules";

export * from "./LunaPlugin";
export * from "./ReactiveStore";

// Ensure this is loaded
import "./window.core";

import { LunaPlugin } from "./LunaPlugin";

// Wrap loading of plugins in a timeout so native/preload.ts can populate modules with @luna/core (see native/preload.ts)
setTimeout(async () => {
	// Load lib
	await LunaPlugin.fromStorage({ enabled: true, url: "https://luna/luna.lib.native" });
	await LunaPlugin.fromStorage({ enabled: true, url: "https://luna/luna.lib" });
	// Load ui after lib as it depends on it.
	await LunaPlugin.fromStorage({ enabled: true, url: "https://luna/luna.ui" });
	// Load other api's
	await LunaPlugin.fromStorage({ enabled: true, url: "https://luna/luna.dev" });

	// Load all plugins from storage
	await LunaPlugin.loadStoredPlugins();
});
