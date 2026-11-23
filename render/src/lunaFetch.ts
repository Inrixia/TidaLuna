// luna.fetch for page plugins: the request is made by Luna's main process, which checks the host against the `hosts` the
// user accepted for the calling plugin and logs it (native/core/net.ts). The calling plugin is found from the stack
// (plugin code runs with `//# sourceURL=<url>.mjs`).
//
// Every plugin shares the page's realm, so this attributes honest plugins' requests; it doesn't stop a hostile plugin, which
// can call the page's own fetch. Plugins with an isolated world get the same function from "@luna/world", where the
// check holds for the world's code.
import { toNetRequest, toResponse } from "./helpers/netMessages";
import { LunaPlugin } from "./LunaPlugin";

/**
 * fetch through Luna's main process, for the calling plugin: limited to the hosts in its package.json `hosts`, any public
 * host in compatibility mode (no `hosts`). Shown in Luna Settings > Network. No cookies are sent and CORS doesn't apply
 */
export const lunaFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	// Before any await: the stack still holds the caller's frame
	const plugin = LunaPlugin.fromStack(new Error().stack);
	if (plugin === undefined) throw new Error("[Luna.net] lunaFetch: can't tell which plugin is calling. Call it from your plugin's code");
	return toResponse(await __LunaCore.fetch(plugin.url, await toNetRequest(input, init)));
};
