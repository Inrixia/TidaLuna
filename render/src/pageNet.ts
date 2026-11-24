// Strict network for page plugins. The TIDAL shell comes with an enforced connect-src (native/cspReportOnly.ts
// enforcedPolicy): page code reaches with fetch, XMLHttpRequest, WebSocket, EventSource and sendBeacon only TIDAL, Luna
// and the hosts enabled plugins may reach. That CSP is the boundary; this file only makes it livable:
// - a page plugin's fetch to a host outside it goes through luna.fetch instead (native/core/net.ts), which asks the user
//   ("only now", "always", "deny") and checks the answer for that plugin, so a host allowed now works at once;
// - a WebSocket, XMLHttpRequest or EventSource to such a host asks the same way, and works from the next reload if
//   allowed (the CSP is built when the shell loads);
// - every block is shown as a toast and in Luna Settings > Network.
// The calling plugin is found from the stack, like lunaFetch: page code can get the page's fetch from elsewhere (an
// iframe) and skip all this, and then the CSP blocks it.
import { settingKeys, settingValueOf } from "../../native/core/hosts";
import { installPageNet } from "./helpers/pageNetHooks";
import { refusalReason, toastGate } from "./helpers/pageNetRules";
import { LunaPlugin } from "./LunaPlugin";
import { ReactiveStore } from "./ReactiveStore";
import { coreTrace } from "./trace";

const trace = coreTrace.withSource(".net").trace;

/** The plugin whose code is calling, found from the stack (deeper than the default 10 frames) */
export const callingPlugin = (): LunaPlugin | undefined => {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 50;
	try {
		return LunaPlugin.fromStack(new Error().stack);
	} finally {
		Error.stackTraceLimit = limit;
	}
};

// One toast for a plugin and host every half minute: a plugin polling a blocked host doesn't fill the screen
const toastDue = toastGate();
export const toastBlocked = (who: string, target: string, reason?: string) => {
	if (!toastDue(who, target)) return;
	trace.msg.warn(`Blocked: ${who} -> ${target}${reason ? ` (${reason})` : ""}. Luna Settings > Network`);
};

/** Toasts a luna.fetch error if it is a refusal (net.ts NetRefused; only its message crosses IPC), not a network failure */
export const toastIfRefused = (who: string, target: string, err: unknown) => {
	const reason = refusalReason(err);
	if (reason !== undefined) toastBlocked(who, target, reason);
};

// The plugin's settings its `{setting:<key>}` entries name, as luna.fetch takes them
const settingKeysOf = new Map<string, { at: number; keys: Promise<string[]> }>();
export const settingsFor = async (plugin: LunaPlugin): Promise<Record<string, unknown> | undefined> => {
	let cached = settingKeysOf.get(plugin.url);
	if (cached === undefined || Date.now() - cached.at > 30_000) {
		cached = {
			at: Date.now(),
			keys: __LunaCore
				.info(plugin.url)
				.then((info) => settingKeys(info?.hosts ?? []))
				.catch(() => []),
		};
		settingKeysOf.set(plugin.url, cached);
	}
	const keys = await cached.keys;
	if (keys.length === 0) return undefined;
	// The live values (a change reaches IndexedDB a moment later), without making an entry for a storage name the plugin
	// doesn't use
	const pluginStorage = ReactiveStore.getStore("@luna/pluginStorage");
	const storage = (name: string) => pluginStorage.current<Record<string, unknown>>(name);
	return Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await settingValueOf(key, plugin.name, storage)])));
};

installPageNet(window as unknown as Parameters<typeof installPageNet>[0], {
	pageConnect: () => __LunaCore.pageConnect(),
	lunaFetch: (pluginUrl, request, settings) => __LunaCore.fetch(pluginUrl, request, settings),
	askHost: (pluginUrl, target) => __LunaCore.askHost(pluginUrl, target),
	callingPlugin,
	settingsFor: (plugin) => settingsFor(plugin as LunaPlugin),
	blocked: toastBlocked,
	refused: toastIfRefused,
	warn: (message) => trace.msg.warn(message),
	error: (message, err) => trace.err(message, err),
});
