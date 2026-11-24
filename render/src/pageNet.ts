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
import { hostAllowed, settingKeys } from "../../native/core/hosts";
import { toNetRequest, toResponse } from "./helpers/netMessages";
import { LunaPlugin } from "./LunaPlugin";
import { ReactiveStore } from "./ReactiveStore";
import { coreTrace } from "./trace";

const trace = coreTrace.withSource(".net").trace;

let connect: string[] | undefined;
const connectReady = __LunaCore.pageConnect().then(
	(entries) => void (connect = entries),
	(err) => {
		trace.err("Can't read the page's connect-src", err);
		connect = [];
	},
);

/** The page's enforced connect-src allows this url (TIDAL's own shell origin always) */
const pageAllows = (url: URL) => url.origin === location.origin || hostAllowed(connect ?? [], url);

const isNetwork = (url: URL) => ["http:", "https:", "ws:", "wss:"].includes(url.protocol);

/** The plugin whose code is calling, found from the stack (deeper than the default 10 frames) */
const callingPlugin = (): LunaPlugin | undefined => {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 50;
	try {
		return LunaPlugin.fromStack(new Error().stack);
	} finally {
		Error.stackTraceLimit = limit;
	}
};

// One toast for a plugin and host every half minute: a plugin polling a blocked host doesn't fill the screen
const toasted = new Map<string, number>();
export const toastBlocked = (who: string, target: string, reason?: string) => {
	const key = `${who}\n${target}`;
	const now = Date.now();
	if (now - (toasted.get(key) ?? 0) < 30_000) return;
	toasted.set(key, now);
	if (toasted.size > 200) toasted.clear();
	trace.msg.warn(`Blocked: ${who} -> ${target}${reason ? ` (${reason})` : ""}. Luna Settings > Network`);
};

/** Toasts a luna.fetch error if it is a refusal (net.ts NetRefused; only its message crosses IPC), not a network failure */
export const toastIfRefused = (who: string, target: string, err: unknown) => {
	const message = String((err as Error)?.message ?? err);
	const at = message.indexOf("luna.fetch refused");
	if (at !== -1) toastBlocked(who, target, message.slice(at + "luna.fetch refused".length).replace(/^[a-z ]*:\s*/, "").slice(0, 160));
};

// The plugin's settings its `{setting:<key>}` entries name, as luna.fetch takes them
const settingKeysOf = new Map<string, { at: number; keys: Promise<string[]> }>();
export const settingsFor = async (plugin: LunaPlugin): Promise<Record<string, unknown> | undefined> => {
	let cached = settingKeysOf.get(plugin.url);
	if (cached === undefined || Date.now() - cached.at > 30_000) {
		cached = { at: Date.now(), keys: __LunaCore.info(plugin.url).then((info) => settingKeys(info?.hosts ?? [])).catch(() => []) };
		settingKeysOf.set(plugin.url, cached);
	}
	const keys = await cached.keys;
	if (keys.length === 0) return undefined;
	const storage = await ReactiveStore.getPluginStorage<Record<string, unknown>>(plugin.name);
	return Object.fromEntries(keys.map((key) => [key, storage[key]]));
};

const nativeFetch = window.fetch;
window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
	let url: URL | undefined;
	try {
		url = new URL(input instanceof Request ? input.url : String(input), location.href);
	} catch {}
	// Before any await: the stack still holds the caller's frame
	const plugin = url !== undefined && isNetwork(url) && url.origin !== location.origin ? callingPlugin() : undefined;
	if (plugin === undefined) return nativeFetch.call(this, input, init);
	return (async () => {
		await connectReady;
		if (pageAllows(url!)) return nativeFetch.call(this, input, init);
		// Outside the page's CSP: luna.fetch asks the user and checks the answer for this plugin. No cookies, no CORS,
		// the whole body at once
		try {
			return toResponse(await __LunaCore.fetch(plugin.url, await toNetRequest(input, init), await settingsFor(plugin)));
		} catch (err) {
			toastIfRefused(plugin.name, url!.host, err);
			throw err;
		}
	})();
} as typeof fetch;

/** For the requests that can't go through luna.fetch: asks now, the answer reaches the page's CSP from its next load */
const askLater = (rawUrl: string | URL, kind: string) => {
	let url: URL;
	try {
		url = new URL(String(rawUrl), location.href);
	} catch {
		return;
	}
	if (!isNetwork(url) || url.origin === location.origin) return;
	const plugin = callingPlugin();
	if (plugin === undefined) return;
	void connectReady.then(async () => {
		if (pageAllows(url)) return;
		const { allowed, reason, answer } = await __LunaCore
			.askHost(plugin.url, url.href)
			.catch((err): { allowed: boolean; reason?: string; answer?: string } => ({ allowed: false, reason: String(err?.message ?? err) }));
		// This attempt was blocked by the page's CSP either way; only an "always" answer is in it from the next load
		if (!allowed) toastBlocked(plugin.name, url.host, reason);
		else if (answer === "always") trace.msg.warn(`${plugin.name} may reach ${url.host}: its ${kind} works once TIDAL reloads (Ctrl+R)`);
		else toastBlocked(plugin.name, url.host, `its ${kind} needs "Always allow": the page's policy is built when it loads`);
	});
};

const NativeWebSocket = window.WebSocket;
window.WebSocket = new Proxy(NativeWebSocket, {
	construct(target, args: [string | URL, (string | string[])?], newTarget) {
		askLater(args[0], "WebSocket");
		return Reflect.construct(target, args, newTarget);
	},
});
const NativeEventSource = window.EventSource;
window.EventSource = new Proxy(NativeEventSource, {
	construct(target, args: [string | URL, EventSourceInit?], newTarget) {
		askLater(args[0], "EventSource");
		return Reflect.construct(target, args, newTarget);
	},
});
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: [string, string | URL, ...unknown[]]) {
	askLater(args[1], "XMLHttpRequest");
	return (open as (...args: unknown[]) => void).apply(this, args);
};
const sendBeacon = navigator.sendBeacon.bind(navigator);
navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
	askLater(url, "sendBeacon");
	return sendBeacon(url, data);
};

// What the enforced CSP blocked, whoever sent it: TIDAL's own requests too (a host the baseline misses shows here)
document.addEventListener("securitypolicyviolation", (event) => {
	if (event.disposition !== "enforce") return;
	let host = event.blockedURI;
	try {
		host = new URL(event.blockedURI).host;
	} catch {}
	toastBlocked(event.effectiveDirective, host);
});
