import { LunaPlugin } from "../LunaPlugin";
import { ReactiveStore } from "../ReactiveStore";

/**
 * Apply settings from a luna-settings.json file.
 */
export async function applySeedSettings(): Promise<void> {
    try {
        const seed = await __ipcRenderer.invoke("__Luna.getSeedSettings");
        if (seed == null) return;
        console.log("[Luna.seed] Applying seed settings");

        // Full replace of store URLs
        if (Array.isArray(seed.stores)) {
            const pluginStores = ReactiveStore.getStore("@luna/pluginStores");
            await pluginStores.set("storeUrls", seed.stores);
        }

        if (seed.pluginSettings && typeof seed.pluginSettings === "object") {
            const pluginStorage = ReactiveStore.getStore("@luna/pluginStorage");
            await pluginStorage.clear();
            console.log("[Luna.seed] Applying plugin settings");

            for (const [pluginName, settings] of Object.entries(seed.pluginSettings)) {
                if (typeof settings !== "object" || settings == null) continue;
                await pluginStorage.set(pluginName, settings);
            }

        }

        // Install the plugins in the background so it doesn't block the boot sequence
        if (Array.isArray(seed.plugins)) {
            applyPlugins(seed.plugins).catch((err) => console.error("[Luna.seed] Plugin sync failed:", err));
        }
    } catch (err) {
        console.error("[Luna.seed] Failed to apply seed settings:", err);
    }
}

/**
 * Resolve plugin names against registered stores and reconcile installed plugins.
 */
async function applyPlugins(pluginNames: unknown[]): Promise<void> {
    const declaredNames = new Set<string>(pluginNames.filter((n): n is string => typeof n === "string"));

    // Build a name → URL index by fetching every store manifest and then
    // each plugin's package.json (which contains the real plugin name).
    const pluginIndex = new Map<string, string>();
    const pluginStores = ReactiveStore.getStore("@luna/pluginStores");
    const storeUrls = await pluginStores.getReactive<string[]>("storeUrls", []);
    await Promise.all(
        [...storeUrls].map(async (storeUrl) => {
            try {
                const res = await fetch(`${storeUrl}/store.json`);
                if (!res.ok) return;
                const manifest = await res.json();
                if (!Array.isArray(manifest.plugins)) return;
                await Promise.all(
                    manifest.plugins.map(async (pluginFile: string) => {
                        if (typeof pluginFile !== "string") return;
                        const baseName = pluginFile.replace(/\.mjs$/, "");
                        const pluginUrl = `${storeUrl}/${baseName}`;
                        try {
                            const pkg = await LunaPlugin.fetchPackage(pluginUrl);
                            if (pkg?.name) pluginIndex.set(pkg.name, pluginUrl);
                        } catch {
                            // TODO: Show toast in Tidal?
                        }
                    }),
                );
            } catch {
                // TODO: Show toast in Tidal?
            }
        }),
    );

    // Install / enable every declared plugin
    for (const name of declaredNames) {
        const url = pluginIndex.get(name);
        if (url === undefined) {
            console.warn(`[Luna.seed] Plugin "${name}" not found in any registered store`);
            continue;
        }
        try {
            const plugin = await LunaPlugin.fromStorage({ url });
            if (!plugin.installed) await plugin.install();
            else if (!plugin.enabled) await plugin.enable();
        } catch (err) {
            console.error(`[Luna.seed] Failed to install plugin "${name}":`, err);
        }
    }

    // Uninstall any persisted plugin not in the declared set (skip core plugins)
    const storedNames = await LunaPlugin.pluginStorage.keys();
    for (const name of storedNames) {
        if (declaredNames.has(name) || LunaPlugin.corePlugins.has(name)) continue;
        try {
            const plugin = await LunaPlugin.fromName(name);
            if (plugin?.installed) await plugin.uninstall();
            else await LunaPlugin.pluginStorage.del(name);
        } catch (err) {
            console.error(`[Luna.seed] Failed to uninstall undeclared plugin "${name}":`, err);
        }
    }
    console.log("[Luna.seed] Plugin sync complete");
}
