// luna.fetch for page plugins: the request is made by Luna's main process, which checks the host against the `hosts` the
// user accepted for the calling plugin and logs it (native/core/net.ts). The calling plugin is found from the stack
// (plugin code runs with `//# sourceURL=<url>.mjs`).
//
// Every plugin shares the page's realm, so this attributes honest plugins' requests; it doesn't stop a hostile plugin, which
// can call the page's own fetch. Plugins with an isolated world get the same function from "@luna/world", where the
// check holds for the world's code.
import { toNetRequest, toResponse } from "./helpers/netMessages";
import { callingPlugin, settingsFor, toastIfRefused } from "./pageNet";

/**
 * fetch through Luna's main process, for the calling plugin: limited to the hosts the user accepted for it (its
 * package.json `hosts`, or the ones luna-registry found in its code); any other host is asked about (only now, always,
 * deny). Plugins on the reviewed legacy list reach any public host. Shown in Luna Settings > Network. No cookies are sent and CORS doesn't apply.
 * The whole body arrives at once (at most 32 MB); the request fails after 30 s without data. `init.signal` isn't passed on:
 * aborting doesn't stop the request in the main process
 */
export const lunaFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	// Before any await: the stack still holds the caller's frame (read deeper than the default 10 frames)
	const plugin = callingPlugin();
	if (plugin === undefined) throw new Error("[Luna.net] lunaFetch: can't tell which plugin is calling. Call it from your plugin's code");
	try {
		return toResponse(await __LunaCore.fetch(plugin.url, await toNetRequest(input, init), await settingsFor(plugin)));
	} catch (err) {
		let host = String(input instanceof Request ? input.url : input);
		try {
			host = new URL(host).host;
		} catch {}
		toastIfRefused(plugin.name, host, err);
		throw err;
	}
};
