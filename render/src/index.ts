/// <reference path="../../luna.d.ts" />
// Hook fetch before TIDAL runs so its requests fill the cache
export { requestCache, type RequestCacheRule } from "./requestCache";
// Always expose internals first
export { tidalModules } from "./exposeTidalInternals";
export { buildActions, interceptors } from "./exposeTidalInternals.patchAction";

export * as ftch from "./helpers/fetch";
export { findModuleByProperty, findModuleProperty, recursiveSearch } from "./helpers/findModule";
export { unloadSet, type LunaUnload, type LunaUnloads, type NullishLunaUnloads } from "./helpers/unloadSet";

export { Messager, Tracer } from "./trace";

export { modules, reduxStore } from "./modules";

export * from "./LunaPlugin";
export * from "./LunaRegistry";
export { isCoreUrl } from "./helpers/pluginUpdates";
export {
	defaultRegistryBase,
	registryPublicKey,
	unverifiedPlugins,
	type RegistryFileName,
	type RevokedEntry,
	type RevokedFile,
	type VerifiedEntry,
	type VerifiedFile,
} from "./helpers/registry";
export * from "./ReactiveStore";
export * from "./SettingsTransfer";

// Ensure this is loaded
import "./window.core";

import { LunaPlugin } from "./LunaPlugin";
import { LunaRegistry } from "./LunaRegistry";
import { applySeedSettings } from "./helpers/applySeedSettings";

// Wrap loading of plugins in a timeout so native/preload.ts can populate modules with @luna/core (see native/preload.ts)
setTimeout(async () => {
	// Load lib
	await LunaPlugin.fromStorage({ enabled: true, url: "https://luna/luna.lib.native" });
	await LunaPlugin.fromStorage({ enabled: true, url: "https://luna/luna.lib" });

	// Load Linux-specific plugins
	if (__platform === "linux") {
		await LunaPlugin.fromStorage({ enabled: true, url: "https://luna/luna.linux" });
	}

	// Load ui after lib as it depends on it.
	await LunaPlugin.fromStorage({ enabled: true, url: "https://luna/luna.ui" });

	// Apply declarative seed settings (e.g. from Nix) before loading user plugins
	await applySeedSettings();

	// The last good registry lists, so a plugin revoked in one never runs. Bounded: a slow or broken IndexedDB must not hold plugins back.
	// The fresh lists are fetched without waiting and then hourly, a newly revoked plugin is unloaded when they arrive (see LunaRegistry)
	await Promise.race([LunaRegistry.loadCached(), new Promise((resolve) => setTimeout(resolve, 3000))]).catch(
		LunaRegistry.trace.err.withContext("loadCached"),
	);
	LunaRegistry.refreshEvery();

	// Load all plugins from storage
	await LunaPlugin.loadStoredPlugins();

	// Load other api's
	await LunaPlugin.fromStorage({ enabled: true, url: "https://luna/luna.dev" });
});
