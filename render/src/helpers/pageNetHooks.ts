// The page's network hooks (pageNet.ts), with the page's globals and Luna core passed in so node:test can drive them
import { toNetRequest, toResponse } from "./netMessages";
import { pageAllowsUrl } from "./pageNetRules";

type Plugin = { url: string; name: string };
type AskResult = { allowed: boolean; reason?: string; answer?: string; notKept?: true };

export type PageNetTarget = {
	fetch: typeof fetch;
	WebSocket: typeof WebSocket;
	EventSource: typeof EventSource;
	XMLHttpRequest: { prototype: { open: (...args: any[]) => void } };
	navigator: { sendBeacon: (url: string | URL, data?: BodyInit | null) => boolean };
	document: { addEventListener(type: "securitypolicyviolation", listener: (event: SecurityPolicyViolationEvent) => void): void };
	location: { origin: string; href: string };
};
export type PageNetDeps = {
	/** The host entries of the page's enforced connect-src (__LunaCore.pageConnect) */
	pageConnect(): Promise<string[]>;
	/** luna.fetch for the plugin (__LunaCore.fetch) */
	lunaFetch(pluginUrl: string, request: Awaited<ReturnType<typeof toNetRequest>>, settings?: Record<string, unknown>): Promise<any>;
	/** Whether the plugin may reach a host with the page's own network, asking the user (__LunaCore.askHost) */
	askHost(pluginUrl: string, target: string): Promise<AskResult>;
	/** The plugin whose code is calling (from the stack) */
	callingPlugin(): Plugin | undefined;
	settingsFor(plugin: Plugin): Promise<Record<string, unknown> | undefined>;
	/** A block, shown as a toast (throttled by the caller) */
	blocked(who: string, target: string, reason?: string): void;
	/** A luna.fetch error: toasted if it is a refusal */
	refused(who: string, target: string, err: unknown): void;
	warn(message: string): void;
	error(message: string, err: unknown): void;
};

export const installPageNet = (page: PageNetTarget, deps: PageNetDeps) => {
	let connect: string[] | undefined;
	const connectReady = deps.pageConnect().then(
		(entries) => void (connect = entries),
		(err) => {
			deps.error("Can't read the page's connect-src", err);
			connect = [];
		},
	);
	const pageAllows = (url: URL) => pageAllowsUrl(connect ?? [], page.location.origin, url);
	const isNetwork = (url: URL) => ["http:", "https:", "ws:", "wss:"].includes(url.protocol);
	/** A url the page's CSP may block, from another origin: once the connect-src is known, one it allows needs no stack */
	const mayBlock = (url: URL) => isNetwork(url) && url.origin !== page.location.origin && !(connect !== undefined && pageAllows(url));

	const nativeFetch = page.fetch;
	page.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
		let url: URL | undefined;
		try {
			url = new URL(input instanceof Request ? input.url : String(input), page.location.href);
		} catch {}
		// Before any await: the stack still holds the caller's frame
		const plugin = url !== undefined && mayBlock(url) ? deps.callingPlugin() : undefined;
		if (plugin === undefined) return nativeFetch.call(this, input, init);
		return (async () => {
			await connectReady;
			if (pageAllows(url!)) return nativeFetch.call(this, input, init);
			// Outside the page's CSP: luna.fetch asks the user and checks the answer for this plugin. No cookies, no CORS,
			// the whole body at once
			try {
				return toResponse(await deps.lunaFetch(plugin.url, await toNetRequest(input, init), await deps.settingsFor(plugin)));
			} catch (err) {
				deps.refused(plugin.name, url!.host, err);
				throw err;
			}
		})();
	} as typeof fetch;

	/** For the requests that can't go through luna.fetch: asks now, the answer reaches the page's CSP from its next load */
	const askLater = (rawUrl: string | URL, kind: string) => {
		let url: URL;
		try {
			url = new URL(String(rawUrl), page.location.href);
		} catch {
			return;
		}
		if (!mayBlock(url)) return;
		const plugin = deps.callingPlugin();
		if (plugin === undefined) return;
		return connectReady.then(async () => {
			if (pageAllows(url)) return;
			const { allowed, reason, answer, notKept } = await deps
				.askHost(plugin.url, url.href)
				.catch((err): AskResult => ({ allowed: false, reason: String(err?.message ?? err) }));
			// This attempt was blocked by the page's CSP either way; an "always" answer, or a host accepted after the page
			// loaded (no answer: a plugin enabled or updated since), is in it from the next load
			if (!allowed) deps.blocked(plugin.name, url.host, reason);
			else if (notKept) deps.blocked(plugin.name, url.host, `Luna can't keep an answer for this host, so its ${kind} can't reach it from the page`);
			else if (answer === "always" || answer === undefined)
				deps.warn(`${plugin.name} may reach ${url.host}: its ${kind} works once TIDAL reloads (Ctrl+R)`);
			else deps.blocked(plugin.name, url.host, `its ${kind} needs "Always allow": the page's policy is built when it loads`);
		});
	};
	/** The last ask's promise, for tests */
	let asked: Promise<void> | undefined;
	const hook = (rawUrl: string | URL, kind: string) => void (asked = askLater(rawUrl, kind) ?? asked);

	const NativeWebSocket = page.WebSocket;
	page.WebSocket = new Proxy(NativeWebSocket, {
		construct(target, args: [string | URL, (string | string[])?], newTarget) {
			hook(args[0], "WebSocket");
			return Reflect.construct(target, args, newTarget);
		},
	});
	const NativeEventSource = page.EventSource;
	page.EventSource = new Proxy(NativeEventSource, {
		construct(target, args: [string | URL, EventSourceInit?], newTarget) {
			hook(args[0], "EventSource");
			return Reflect.construct(target, args, newTarget);
		},
	});
	const open = page.XMLHttpRequest.prototype.open;
	page.XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: [string, string | URL, ...unknown[]]) {
		hook(args[1], "XMLHttpRequest");
		return (open as (...args: unknown[]) => void).apply(this, args);
	};
	const sendBeacon = page.navigator.sendBeacon.bind(page.navigator);
	page.navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
		hook(url, "sendBeacon");
		return sendBeacon(url, data);
	};

	// What the enforced CSP blocked, whoever sent it: TIDAL's own requests too (a host the baseline misses shows here)
	page.document.addEventListener("securitypolicyviolation", (event) => {
		if (event.disposition !== "enforce") return;
		let host = event.blockedURI;
		try {
			host = new URL(event.blockedURI).host;
		} catch {}
		deps.blocked(event.effectiveDirective, host);
	});

	return { ready: connectReady, pageAllows, lastAsk: () => asked };
};
