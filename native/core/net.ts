// luna.fetch: plugins' network requests, made by the main process after checking the host against the hosts the user
// accepted for the calling plugin (hosts.ts: declared, or derived by luna-registry), and kept in a log the user can read
// in Luna Settings. Any other host is a question to the user in Luna's own window: allow it only now (until TIDAL
// restarts), always, or deny it; the answer is kept per plugin and host (registry.ts grantHost). A plugin on the signed
// list of plugins from before host lists ("legacy") may reach any public host without asking, until it updates.
//
// Who the caller is:
// - a plugin world (native/worlds.ts): its bridge names its url, fixed by the preload, so the check holds for its code;
// - page code (render/src/lunaFetch.ts): the page names the plugin, found from the call's stack. Every plugin and TIDAL
//   share the page's realm, so this attributes honest plugins' requests but doesn't stop a hostile one, which can name
//   another plugin or call the page's own fetch (the CSP report-only header, cspReportOnly.ts, logs those).
//
// Kept apart from Electron (its fetch and the registry come in as NetDeps) so it can be tested.
import { hostAllowed, isLocalHost, localEntryAllows, parseHostEntry, resolveSettings } from "./hosts";
import type { HostGrant, PluginNet } from "./registry";

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
	/** On the old format list: allowed without asking (any public host) */
	compat: boolean;
	/** Allowed by the user's answer at runtime, not by the accepted hosts */
	asked?: HostAnswer;
	status?: number;
	error?: string;
};
/** What the registry says about the plugin: undefined if it isn't an enabled plugin */
export type PluginHosts = PluginNet | undefined;

/** The user's answer to "allow X?": "once" lasts until TIDAL restarts */
export type HostAnswer = "once" | HostGrant;
export type HostQuestion = {
	plugin: string;
	name: string;
	/** The entry the answer is kept under: scheme, host and port (`https://api.example.com`) */
	entry: string;
	/** The url asked for, without its query */
	example: string;
	/** Why it is asked */
	reason: "unlisted" | "unconfirmed" | "not-listed" | "local-setting" | "redirect" | "resolves-local";
	/** Luna can't keep an answer for this host (an IPv6 address, a single-label name): any answer lasts until TIDAL restarts */
	notKept?: true;
};
/** Asks the user, in a window over the caller's TIDAL. Undefined, or a throw, if they couldn't be asked */
export type AskHost = (question: HostQuestion) => Promise<HostAnswer | undefined>;

export type NetDeps = {
	hostsOf(url: string): PluginHosts;
	/** Keeps an "always" or "deny" answer (registry.ts grantHost); false or a throw: not kept, it counts until restart */
	grant?(pluginUrl: string, entry: string, grant: HostGrant): void | boolean | Promise<unknown>;
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
// Headers about the connection: a plugin can't set them (`host` would make the server see a name that wasn't checked)
const connectionHeaders = ["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-connection"];
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
/** The entry an answer about this url is kept under: its scheme, host and port, written out */
export const answerEntry = (url: URL) => `${url.protocol}//${url.host}`;

export class NetRefused extends Error {}

export const createNet = (deps: NetDeps) => {
	/**
	 * `${plugin url}\n${entry}` answered "once" until TIDAL restarts or the plugin is uninstalled, or "always" for a host the
	 * hosts grammar can't keep (an IPv6 address, a name ending in ".") or the registry didn't: matched as written, not as a
	 * host entry
	 */
	const onceAllowed = new Set<string>();
	/** The keys of onceAllowed answered "always" (not kept: page code hears it isn't in the page's CSP) */
	const alwaysNotKept = new Set<string>();
	/** `${plugin url}\n${entry}` denied for a host the grammar can't keep, or the registry didn't: until TIDAL restarts, as written */
	const onceDenied = new Set<string>();
	/** `${plugin url}\n${entry}\nlocal`: the user's answer for a public name that resolved to a local address, until restart */
	const resolvedLocalAllowed = new Set<string>();
	const resolvedLocalDenied = new Set<string>();
	/** Questions waiting for the user, so that many requests to one new host ask once */
	const asking = new Map<string, Promise<HostAnswer | undefined>>();
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

	/** `url` with each scheme a plugin's request may use (a deny of https://tracker.example holds for its wss:// too) */
	const sameHostOtherSchemes = (url: URL) =>
		["http:", "https:", "ws:", "wss:"].map((scheme) => {
			if (scheme === url.protocol) return url;
			const other = new URL(url.href);
			other.protocol = scheme;
			return other;
		});

	/** The user's answer for this plugin and host, asked once however many requests wait for it */
	const askOnce = (pluginUrl: string, plugin: NonNullable<PluginHosts>, url: URL, reason: HostQuestion["reason"], ask: AskHost | undefined) => {
		const entry = answerEntry(url);
		// A public name that resolves to a local address: its own question, answered until restart only
		const resolvesLocal = reason === "resolves-local";
		const key = `${pluginUrl}\n${entry}${resolvesLocal ? "\nlocal" : ""}`;
		let answer = asking.get(key);
		if (answer === undefined) {
			const keepable = !resolvesLocal && parseHostEntry(entry) !== undefined;
			const question: HostQuestion = {
				plugin: pluginUrl,
				name: plugin.name,
				entry,
				example: targetOf(url),
				reason,
				...(keepable ? {} : { notKept: true as const }),
			};
			answer = (ask === undefined ? Promise.resolve(undefined) : ask(question).catch(() => undefined)).then(async (got) => {
				if (resolvesLocal) {
					if (got === "once" || got === "always") resolvedLocalAllowed.add(key);
					else if (got === "deny") resolvedLocalDenied.add(key);
				} else if (got === "once") onceAllowed.add(key);
				else if (got === "always" && !keepable) (onceAllowed.add(key), alwaysNotKept.add(key));
				else if (got === "deny" && !keepable) onceDenied.add(key);
				else if (got === "always" || got === "deny") {
					// Not kept (the plugin was uninstalled meanwhile, the registry failed): the answer still counts, until restart
					const kept = await Promise.resolve()
						.then(() => deps.grant?.(pluginUrl, entry, got))
						.then((result) => result !== false)
						.catch((err) => {
							console.error("[Luna.core] Can't keep the answer for", entry, err);
							return false;
						});
					if (!kept && got === "always") (onceAllowed.add(key), alwaysNotKept.add(key));
					else if (!kept) onceDenied.add(key);
				}
				return got;
			});
			asking.set(key, answer);
			void answer.finally(() => asking.delete(key));
		}
		return answer;
	};

	/**
	 * Why `url` is refused for the plugin, or undefined if it may be fetched. A host the plugin's accepted hosts don't
	 * cover is asked (`ask`); `answered` gets the answer that let it through
	 */
	const refusal = async (
		pluginUrl: string,
		plugin: NonNullable<PluginHosts>,
		url: URL,
		ask: AskHost | undefined,
		settings: Record<string, unknown> | undefined,
		answered?: (answer: HostAnswer) => void,
		{ redirected = false, page = false }: { redirected?: boolean; page?: boolean } = {},
	): Promise<string | undefined> => {
		const schemes = page ? ["http:", "https:", "ws:", "wss:"] : ["http:", "https:"];
		if (!schemes.includes(url.protocol)) return `${url.protocol} urls can't be fetched`;
		if (url.username !== "" || url.password !== "") return "urls with credentials can't be fetched";
		const deny = plugin.deny ?? [];
		if (sameHostOtherSchemes(url).some((each) => hostAllowed(deny, each) || onceDenied.has(`${pluginUrl}\n${answerEntry(each)}`)))
			return `you denied ${url.host} for ${plugin.name}`;
		const local = `${url.hostname} is a local address: ${plugin.name} must list it in its hosts as a local entry`;
		// A legacy plugin's luna.fetch reaches public hosts as it is; its page requests (a WebSocket) are asked like any
		// plugin's, as an "always" answer is the only way into the page's CSP
		if (plugin.mode !== "legacy" || page) {
			const { hosts, settings: fromSettings } = resolveSettings(plugin.hosts ?? [], (key) =>
				settings !== null && typeof settings === "object" && Object.hasOwn(settings, key) ? (settings as Record<string, unknown>)[key] : undefined,
			);
			// The declared entries themselves: one a setting's value happens to equal stays declared
			const fixed = hosts.filter((entry) => !fromSettings.includes(entry) || (plugin.hosts ?? []).includes(entry));
			const allowed = [
				...fixed,
				...(plugin.allow ?? []),
				...[...onceAllowed].filter((key) => key.startsWith(`${pluginUrl}\n`)).map((key) => key.slice(pluginUrl.length + 1)),
			];
			// A local entry the user saw ("localhost", "nas.lan", or an answer for a local address) may reach a local
			// address; a public one may not
			// An answer kept as written (onceAllowed) names this very host: for a local address, a local entry the user saw
			const keptAsWritten = onceAllowed.has(`${pluginUrl}\n${answerEntry(url)}`);
			if (keptAsWritten || hostAllowed(allowed, url)) {
				if ((keptAsWritten && isLocalHost(url.hostname)) || localEntryAllows(allowed, url)) return undefined;
			} else if (hostAllowed(fromSettings, url) && !isLocalHost(url.hostname)) {
				// The server in a setting: a public one is allowed as it is, a local one is asked below
			} else {
				const reason = hostAllowed(fromSettings, url)
					? "local-setting"
					: redirected
						? "redirect"
						: plugin.mode === "unlisted"
							? plugin.unconfirmed
								? "unconfirmed"
								: "unlisted"
							: "not-listed";
				const answer = await askOnce(pluginUrl, plugin, url, reason, ask);
				if (answer === undefined) return `${url.host} is not in the hosts of ${plugin.name}, and you didn't allow it`;
				if (answer === "deny") return `you denied ${url.host} for ${plugin.name}`;
				answered?.(answer);
				// The answer names this host: a local address is now a local entry the user saw
				if (isLocalHost(url.hostname)) return undefined;
			}
		}
		// A legacy plugin's own local entries (its legacy list's, as in the page's CSP) reach their local addresses
		if (plugin.mode === "legacy" && !page && localEntryAllows(plugin.hosts ?? [], url)) return undefined;
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
			if (addresses.some(isLocalHost)) {
				// A server the user runs under a public name (split DNS, a home server): asked, never let through silently
				const key = `${pluginUrl}\n${answerEntry(url)}\nlocal`;
				if (resolvedLocalAllowed.has(key)) return undefined;
				if (resolvedLocalDenied.has(key)) return local;
				const answer = await askOnce(pluginUrl, plugin, url, "resolves-local", ask);
				if (answer === "once" || answer === "always") {
					answered?.(answer);
					return undefined;
				}
				return answer === "deny" ? `you denied ${url.host} for ${plugin.name}` : local;
			}
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

	/**
	 * @param ask Asks the user who made the request about a host the plugin's hosts don't cover; without it such a host
	 * is refused
	 * @param settings The plugin's settings its `{setting:<key>}` entries name, as the page has them now (page code can
	 * write any plugin's settings: a local server from one is still asked)
	 */
	const fetchFor = async (pluginUrl: unknown, via: Via, request: unknown, ask?: AskHost, settings?: unknown): Promise<NetResponse> => {
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
			compat: plugin?.mode === "legacy",
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
			if (connectionHeaders.includes(name.toLowerCase())) refuse(`header ${name} can't be set`);
			headers[name] = value;
		}
		const key = entry.plugin;
		if ((inFlight.get(key) ?? 0) >= maxInFlightPerPlugin || inFlightTotal >= maxInFlight) refuse("too many requests at once");
		inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
		inFlightTotal++;
		try {
			return await fetchAllowed(
				pluginUrl as string,
				plugin!,
				url,
				method,
				headers,
				body,
				entry,
				refuse,
				ask,
				settings as Record<string, unknown> | undefined,
			);
		} finally {
			inFlightTotal--;
			const left = (inFlight.get(key) ?? 1) - 1;
			if (left === 0) inFlight.delete(key);
			else inFlight.set(key, left);
		}
	};

	const fetchAllowed = async (
		pluginUrl: string,
		plugin: NonNullable<PluginHosts>,
		firstUrl: URL,
		method: string,
		headers: Record<string, string>,
		body: string | Uint8Array | undefined,
		entry: NetLogEntry,
		refuse: (reason: string) => never,
		ask: AskHost | undefined,
		settings: Record<string, unknown> | undefined,
	): Promise<NetResponse> => {
		let url = firstUrl;
		const firstRefusal = await refusal(pluginUrl, plugin, url, ask, settings, (answer) => (entry.asked = answer));
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
					// Every hop is checked like the first: a declared host can't redirect the plugin to another one. The user's
					// answer takes its time: no timeout while Luna asks
					clearTimeout(timer);
					const hopRefusal = await refusal(pluginUrl, plugin, url, ask, settings, (answer) => (entry.asked ??= answer), { redirected: true });
					alive();
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
		/** Forgets the plugin's answers kept until restart: it was uninstalled, or moved to another url */
		forget: (pluginUrl: string) => {
			for (const kept of [onceAllowed, alwaysNotKept, onceDenied, resolvedLocalAllowed, resolvedLocalDenied])
				for (const key of kept) if (key.startsWith(`${pluginUrl}\n`)) kept.delete(key);
		},
		/**
		 * For a request page code makes with the page's own network (a WebSocket, an XMLHttpRequest) to a host the page's
		 * CSP blocks: whether the plugin may reach it, asking the user like luna.fetch. Logged like a luna.fetch request
		 */
		ask: async (
			pluginUrl: unknown,
			target: unknown,
			ask?: AskHost,
			/** As for fetch: the plugin's settings its `{setting:<key>}` entries name */
			settings?: unknown,
		): Promise<{ allowed: boolean; reason?: string; answer?: HostAnswer; notKept?: true }> => {
			const plugin = typeof pluginUrl === "string" ? deps.hostsOf(pluginUrl) : undefined;
			let url: URL;
			try {
				if (typeof target !== "string" || target.length > maxUrlLength) throw new Error();
				url = new URL(target);
			} catch {
				return { allowed: false, reason: "not a url" };
			}
			const entry: NetLogEntry = {
				time: (deps.now ?? Date.now)(),
				plugin: clip(typeof pluginUrl === "string" ? pluginUrl : typeof pluginUrl),
				via: "page",
				method: "PAGE",
				target: targetOf(url),
				allowed: false,
				compat: plugin?.mode === "legacy",
			};
			const reason =
				plugin === undefined
					? `${entry.plugin} is not an enabled plugin`
					: await refusal(
							pluginUrl as string,
							plugin,
							url,
							ask,
							settings as Record<string, unknown> | undefined,
							(answer) => (entry.asked = answer),
							{ page: true },
						);
			entry.allowed = reason === undefined;
			if (reason !== undefined) entry.error = reason;
			record(entry, plugin !== undefined);
			if (reason !== undefined) return { allowed: false, reason };
			// Allowed only in memory ("only now", or an answer that couldn't be kept): the page's CSP, built from kept grants,
			// never has it
			const key = `${pluginUrl}\n${answerEntry(url)}`;
			if (onceAllowed.has(key))
				return parseHostEntry(answerEntry(url)) !== undefined && !alwaysNotKept.has(key)
					? { allowed: true, answer: "once" }
					: { allowed: true, answer: alwaysNotKept.has(key) ? "always" : "once", notKept: true };
			return entry.asked === undefined ? { allowed: true } : { allowed: true, answer: entry.asked };
		},
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
