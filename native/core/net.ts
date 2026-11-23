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
import { hostAllowed, isLocalHost, localEntryAllows } from "./hosts";

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
	/**
	 * The addresses a name resolves to (compatibility mode refuses a name for a local address). The fetch resolves it again,
	 * so a name that changes its answer in between (DNS rebinding) isn't caught
	 */
	resolve?(hostname: string): Promise<string[]>;
	now?: () => number;
	timeoutMs?: number;
	maxBytes?: number;
};

/** Entries kept for each plugin: one plugin's requests can't push another's out of the log */
const logLimitPerPlugin = 100;
/** Bucket of requests naming no enabled plugin (any page code can send them) */
const unknownPlugin = "";
const maxRedirects = 5;
// The statuses fetch follows; a 304 or 300 with a Location is an answer, not a redirect
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxUrlLength = 8192;
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
// Not sent on to another origin after a redirect, as browsers do
const crossOriginDropped = ["authorization", "cookie", "proxy-authorization"];
// Headers about the body, dropped with it when a redirect continues as GET
const bodyHeaders = ["content-type", "content-encoding", "content-language", "content-location", "content-length"];
// The encodings fetch decodes: their content-encoding/content-length describe the encoded body, not the one handed on
const decodedEncodings = new Set(["gzip", "x-gzip", "deflate", "br", "zstd"]);
/** Request bodies larger than this are refused (they are held in the main process) */
const maxRequestBytes = 32 * 1024 * 1024;
/** Requests one plugin may have in flight, and all plugins together */
const maxInFlightPerPlugin = 16;
const maxInFlight = 64;

const clip = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text);
const targetOf = (url: URL) => clip(`${url.protocol}//${url.host}${url.pathname}`);
const isIpLiteral = (hostname: string) => /^[\d.]+$/.test(hostname) || hostname.startsWith("[");

export class NetRefused extends Error {}

export const createNet = (deps: NetDeps) => {
	const logs = new Map<string, NetLogEntry[]>();
	const inFlight = new Map<string, number>();
	let inFlightTotal = 0;
	const record = (entry: NetLogEntry, known: boolean) => {
		const key = known ? entry.plugin : unknownPlugin;
		let log = logs.get(key);
		if (log === undefined) logs.set(key, (log = []));
		log.push(entry);
		if (log.length > logLimitPerPlugin) log.splice(0, log.length - logLimitPerPlugin);
	};

	/** Why `url` is refused for the plugin, or undefined if it may be fetched */
	const refusal = async (plugin: NonNullable<PluginHosts>, url: URL): Promise<string | undefined> => {
		if (!["http:", "https:"].includes(url.protocol)) return `${url.protocol} urls can't be fetched`;
		if (url.username !== "" || url.password !== "") return "urls with credentials can't be fetched";
		if (plugin.hosts !== undefined) {
			if (!hostAllowed(plugin.hosts, url)) return `${url.host} is not in the hosts of ${plugin.name}`;
			// A local entry the user saw ("localhost", "nas.lan") may reach a local address; a public one may not
			if (localEntryAllows(plugin.hosts, url)) return undefined;
		}
		const local = `${url.hostname} is a local address: ${plugin.name} must list it in its hosts as a local entry`;
		if (isLocalHost(url.hostname)) return local;
		if (deps.resolve !== undefined && !isIpLiteral(url.hostname)) {
			// A name that doesn't resolve now is refused: the fetch resolves it again and could get a local answer
			let timer: ReturnType<typeof setTimeout> | undefined;
			const addresses = await Promise.race([
				deps.resolve(url.hostname),
				new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), deps.timeoutMs ?? 30000))),
			])
				.catch(() => undefined)
				.finally(() => clearTimeout(timer));
			if (addresses === undefined || addresses.length === 0) return `${url.hostname} doesn't resolve`;
			if (addresses.some(isLocalHost)) return local;
		}
		return undefined;
	};

	const readBody = async (res: Response, maxBytes: number, alive: () => void) => {
		if (res.body === null) return new Uint8Array();
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			alive();
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
			if (typeof rawUrl !== "string" || rawUrl.length > maxUrlLength) throw new Error();
			url = new URL(rawUrl);
		} catch {
			throw new NetRefused(`[Luna.net] Not a url (or longer than ${maxUrlLength}): ${String(rawUrl).slice(0, 200)}`);
		}
		const entry: NetLogEntry = {
			time: now(),
			plugin: clip(typeof pluginUrl === "string" ? pluginUrl : typeof pluginUrl),
			via,
			method,
			target: targetOf(url),
			allowed: false,
			compat: plugin !== undefined && plugin.hosts === undefined,
		};
		const refuse = (reason: string): never => {
			entry.error = reason;
			record(entry, plugin !== undefined);
			throw new NetRefused(`[🛑Security🛑] luna.fetch refused: ${reason}`);
		};
		if (plugin === undefined) refuse(`${entry.plugin} is not an enabled plugin`);
		if (!methods.has(method)) refuse(`method ${method.slice(0, 20)} is not allowed`);
		if (body !== undefined && typeof body !== "string" && !(body instanceof Uint8Array)) refuse("the body must be a string or bytes");
		if (body !== undefined && (typeof body === "string" ? Buffer.byteLength(body) : body.byteLength) > maxRequestBytes)
			refuse(`the body is larger than ${maxRequestBytes} bytes`);
		const headers: Record<string, string> = {};
		if (rawHeaders !== undefined && (typeof rawHeaders !== "object" || rawHeaders === null)) refuse("headers must be an object");
		for (const [name, value] of Object.entries(rawHeaders ?? {})) {
			if (typeof value !== "string") refuse(`header ${name} must be a string`);
			headers[name] = value;
		}
		const key = entry.plugin;
		if ((inFlight.get(key) ?? 0) >= maxInFlightPerPlugin || inFlightTotal >= maxInFlight) refuse("too many requests at once");
		inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
		inFlightTotal++;
		try {
			return await fetchAllowed(plugin!, url, method, headers, body, entry, refuse);
		} finally {
			inFlightTotal--;
			const left = (inFlight.get(key) ?? 1) - 1;
			if (left === 0) inFlight.delete(key);
			else inFlight.set(key, left);
		}
	};

	const fetchAllowed = async (
		plugin: NonNullable<PluginHosts>,
		firstUrl: URL,
		method: string,
		headers: Record<string, string>,
		body: string | Uint8Array | undefined,
		entry: NetLogEntry,
		refuse: (reason: string) => never,
	): Promise<NetResponse> => {
		let url = firstUrl;
		const firstRefusal = await refusal(plugin, url);
		if (firstRefusal !== undefined) refuse(firstRefusal);

		entry.allowed = true;
		record(entry, true);
		// Times out when nothing arrives for timeoutMs (no answer, or a download that stalls), not after a fixed total
		const controller = new AbortController();
		const timeoutMs = deps.timeoutMs ?? 30000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const alive = () => {
			clearTimeout(timer);
			timer = setTimeout(() => controller.abort(new Error(`No answer for ${timeoutMs / 1000} s`)), timeoutMs);
		};
		alive();
		const { signal } = controller;
		try {
			let currentMethod = method;
			let currentBody = body;
			for (let hop = 0; ; hop++) {
				const res = await deps.fetch(url.href, { method: currentMethod, headers: { ...headers }, body: currentBody, redirect: "manual", signal });
				alive();
				const location = res.headers.get("location");
				if (redirectStatuses.has(res.status) && location !== null) {
					await res.body?.cancel().catch(() => {});
					if (hop >= maxRedirects) throw new Error(`More than ${maxRedirects} redirects`);
					const from = url;
					url = new URL(location, url);
					// Every hop is checked like the first: a declared host can't redirect the plugin to another one
					const hopRefusal = await refusal(plugin, url);
					if (hopRefusal !== undefined) {
						entry.allowed = false;
						throw new NetRefused(`[🛑Security🛑] luna.fetch refused a redirect: ${hopRefusal}`);
					}
					// The plugin's credentials were meant for the origin it named
					if (url.origin !== from.origin)
						for (const name of Object.keys(headers)) if (crossOriginDropped.includes(name.toLowerCase())) delete headers[name];
					// As browsers do: 303, and 301/302 after a POST, continue as GET without a body
					if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
						currentMethod = currentMethod === "HEAD" ? "HEAD" : "GET";
						if (currentBody !== undefined) for (const name of Object.keys(headers)) if (bodyHeaders.includes(name.toLowerCase())) delete headers[name];
						currentBody = undefined;
					}
					continue;
				}
				entry.status = res.status;
				// fetch decodes gzip/br/deflate bodies but keeps the headers of the encoded one (a HEAD answer has no body)
				const encodings =
					res.headers
						.get("content-encoding")
						?.split(",")
						.map((coding) => coding.trim().toLowerCase()) ?? [];
				const decoded = currentMethod !== "HEAD" && encodings.length !== 0 && encodings.every((coding) => decodedEncodings.has(coding));
				return {
					status: res.status,
					statusText: res.statusText,
					url: url.href,
					redirected: hop !== 0,
					headers: [...res.headers].filter(([name]) => !(decoded && (name === "content-encoding" || name === "content-length"))),
					body: await readBody(res, deps.maxBytes ?? 32 * 1024 * 1024, alive),
				};
			}
		} catch (err) {
			entry.error = String((err as Error)?.message ?? err).slice(0, 300);
			throw err;
		} finally {
			clearTimeout(timer);
		}
	};

	return {
		fetch: fetchFor,
		/**
		 * The newest entries last, copied. No way to clear it: any page code could, to hide its requests. It lasts until
		 * TIDAL restarts
		 */
		log: (): NetLogEntry[] =>
			[...logs.values()]
				.flat()
				.sort((a, b) => a.time - b.time)
				.map((entry) => ({ ...entry })),
	};
};
export type Net = ReturnType<typeof createNet>;
