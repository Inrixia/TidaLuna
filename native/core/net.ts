// luna.fetch: plugins' network requests, made by the main process after checking the host against the `hosts` the user
// accepted for the calling plugin (hosts.ts), and kept in a log the user can read in Luna Settings.
//
// Who the caller is:
// - a plugin world (native/worlds.ts): its bridge names its url, fixed by the preload, so the check holds for its code;
// - page code (render/src/lunaFetch.ts): the page names the plugin, found from the call's stack. Every plugin and TIDAL
//   share the page's realm, so this attributes honest plugins' requests but doesn't stop a hostile one, which can name
//   another plugin or call the page's own fetch (the CSP report-only header, cspReportOnly.ts, logs those).
//
// Kept apart from Electron (its fetch and the registry come in as NetDeps) so it can be tested.
import { hostAllowed, isLocalHost } from "./hosts";

export type NetRequest = {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
};
export type NetResponse = {
	status: number;
	statusText: string;
	/** The url of the last response, after redirects */
	url: string;
	redirected: boolean;
	headers: [string, string][];
	body: Uint8Array;
};
export type Via = "world" | "page";
export type NetLogEntry = {
	time: number;
	plugin: string;
	via: Via;
	method: string;
	/** Origin and path, without the query (it may hold keys) */
	target: string;
	allowed: boolean;
	/** The plugin declares no `hosts`: allowed in compatibility mode */
	compat: boolean;
	status?: number;
	error?: string;
};
/** What the registry says about the plugin: undefined if it isn't an enabled plugin, `hosts` undefined if it declares none */
export type PluginHosts = { name: string; hosts?: string[] } | undefined;

export type NetDeps = {
	hostsOf(url: string): PluginHosts;
	fetch(
		url: string,
		init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; redirect: "manual"; signal: AbortSignal },
	): Promise<Response>;
	now?: () => number;
	timeoutMs?: number;
	maxBytes?: number;
};

const logLimit = 500;
const maxRedirects = 5;
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

const targetOf = (url: URL) => `${url.origin}${url.pathname}`;

export class NetRefused extends Error {}

export const createNet = (deps: NetDeps) => {
	const log: NetLogEntry[] = [];
	const record = (entry: NetLogEntry) => {
		log.push(entry);
		if (log.length > logLimit) log.splice(0, log.length - logLimit);
	};

	/** Why `url` is refused for the plugin, or undefined if it may be fetched */
	const refusal = (plugin: NonNullable<PluginHosts>, url: URL): string | undefined => {
		if (!["http:", "https:"].includes(url.protocol)) return `${url.protocol} urls can't be fetched`;
		if (url.username !== "" || url.password !== "") return "urls with credentials can't be fetched";
		if (plugin.hosts === undefined)
			return isLocalHost(url.hostname) ? `${url.hostname} is a local address: ${plugin.name} must list it in its hosts` : undefined;
		return hostAllowed(plugin.hosts, url) ? undefined : `${url.host} is not in the hosts of ${plugin.name}`;
	};

	const readBody = async (res: Response, maxBytes: number) => {
		if (res.body === null) return new Uint8Array();
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new Error(`Response is larger than ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
		const body = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return body;
	};

	const fetchFor = async (pluginUrl: unknown, via: Via, request: unknown): Promise<NetResponse> => {
		const now = deps.now ?? Date.now;
		const plugin = typeof pluginUrl === "string" ? deps.hostsOf(pluginUrl) : undefined;
		const { url: rawUrl, method: rawMethod, headers: rawHeaders, body } = (request ?? {}) as NetRequest;
		const method = typeof rawMethod === "string" ? rawMethod.toUpperCase() : "GET";
		let url: URL;
		try {
			url = new URL(String(rawUrl));
		} catch {
			throw new NetRefused(`[Luna.net] Not a url: ${String(rawUrl).slice(0, 200)}`);
		}
		const entry: NetLogEntry = {
			time: now(),
			plugin: typeof pluginUrl === "string" ? pluginUrl : String(pluginUrl),
			via,
			method,
			target: targetOf(url),
			allowed: false,
			compat: plugin !== undefined && plugin.hosts === undefined,
		};
		const refuse = (reason: string): never => {
			entry.error = reason;
			record(entry);
			throw new NetRefused(`[🛑Security🛑] luna.fetch refused: ${reason}`);
		};
		if (plugin === undefined) refuse(`${entry.plugin} is not an enabled plugin`);
		if (!methods.has(method)) refuse(`method ${method.slice(0, 20)} is not allowed`);
		if (body !== undefined && typeof body !== "string" && !(body instanceof Uint8Array)) refuse("the body must be a string or bytes");
		const headers: Record<string, string> = {};
		if (rawHeaders !== undefined && (typeof rawHeaders !== "object" || rawHeaders === null)) refuse("headers must be an object");
		for (const [name, value] of Object.entries(rawHeaders ?? {})) {
			if (typeof value !== "string") refuse(`header ${name} must be a string`);
			headers[name] = value;
		}
		const firstRefusal = refusal(plugin!, url);
		if (firstRefusal !== undefined) refuse(firstRefusal);

		entry.allowed = true;
		record(entry);
		const signal = AbortSignal.timeout(deps.timeoutMs ?? 30000);
		try {
			let currentMethod = method;
			let currentBody = body;
			for (let hop = 0; ; hop++) {
				const res = await deps.fetch(url.href, { method: currentMethod, headers, body: currentBody, redirect: "manual", signal });
				const location = res.headers.get("location");
				if (res.status >= 300 && res.status < 400 && location !== null) {
					await res.body?.cancel().catch(() => {});
					if (hop >= maxRedirects) throw new Error(`More than ${maxRedirects} redirects`);
					url = new URL(location, url);
					// Every hop is checked like the first: a declared host can't redirect the plugin to another one
					const hopRefusal = refusal(plugin!, url);
					if (hopRefusal !== undefined) {
						entry.allowed = false;
						throw new NetRefused(`[🛑Security🛑] luna.fetch refused a redirect: ${hopRefusal}`);
					}
					// As browsers do: 303, and 301/302 after a POST, continue as GET without a body
					if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
						currentMethod = currentMethod === "HEAD" ? "HEAD" : "GET";
						currentBody = undefined;
					}
					continue;
				}
				entry.status = res.status;
				return {
					status: res.status,
					statusText: res.statusText,
					url: url.href,
					redirected: hop !== 0,
					headers: [...res.headers],
					body: await readBody(res, deps.maxBytes ?? 32 * 1024 * 1024),
				};
			}
		} catch (err) {
			entry.error = String((err as Error)?.message ?? err).slice(0, 300);
			throw err;
		}
	};

	return {
		fetch: fetchFor,
		/** The newest entries last, copied */
		log: (): NetLogEntry[] => log.map((entry) => ({ ...entry })),
		clearLog: () => void log.splice(0),
	};
};
export type Net = ReturnType<typeof createNet>;
