// A plugin's `hosts`: the network hosts its package.json says it connects to, or, without them, the hosts luna-registry
// read from its code (derivedHosts.ts). The user accepts them with the plugin's version (registry.ts shows them in the
// install and update confirmations), and luna.fetch (net.ts) asks the user before any other host for that plugin.
//
// An entry is `[scheme://]host[:port][/path]`, or `{setting:<key>}`:
// - `api.example.com`: https and wss to that host, default ports;
// - `*.example.com`: any subdomain of example.com (not example.com itself). Not under a public suffix (`*.com`,
//   `*.co.uk`, `*.github.io`): that would be anyone's host;
// - `http://127.0.0.1:8080`: only that scheme and port. http and ws need the scheme written out;
// - `*.fastly.net/covers/*`: a path, where `*` stands for any characters (`/` too). No other pattern: no regex;
// - `{setting:serverUrl}`: the host in the plugin's setting `serverUrl` at the moment (a server the user types in),
//   nothing while it is empty. Plugins name their storage themselves: `{setting:Jellyfin.serverUrl}` reads `serverUrl`
//   in the storage `Jellyfin` when the one named like the package has no `Jellyfin.serverUrl`. Resolved by net.ts, never
//   put into the page's CSP (page code can write any setting).
// Kept apart from Electron so it can be tested.

export type HostRule = {
	schemes: string[];
	host: string;
	wildcard: boolean;
	port: string;
	/** The path pattern, "" for any path. `*` stands for any characters */
	path: string;
};

const schemesAllowed = new Set(["http", "https", "ws", "wss"]);
const defaultSchemes = ["https", "wss"];
const defaultPort: Record<string, string> = { http: "80", ws: "80", https: "443", wss: "443" };

const label = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const dnsName = new RegExp(`^${label}(\\.${label})+$`);
const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Suffixes under which anyone can have a name: a wildcard right under one would allow everyone's hosts. The usual
// two-label country suffixes and the hosting services plugins are likely to name; a single label (`*.com`) is refused
// by the name rule already. Not the whole Public Suffix List: the registry flags wildcards it doesn't know
const publicSuffixes = new Set([
	...["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"].flatMap((second) =>
		["uk", "jp", "kr", "au", "nz", "br", "in", "za", "tr", "cn", "tw", "hk", "id", "il", "mx", "ar"].map((tld) => `${second}.${tld}`),
	),
	"github.io",
	"githubusercontent.com",
	"gitlab.io",
	"pages.dev",
	"workers.dev",
	"vercel.app",
	"netlify.app",
	"herokuapp.com",
	"web.app",
	"firebaseapp.com",
	"appspot.com",
	"cloudfront.net",
	"azurewebsites.net",
	"blob.core.windows.net",
	"s3.amazonaws.com",
	"amazonaws.com",
	"onrender.com",
	"fly.dev",
	"repl.co",
	"glitch.me",
	"ngrok.io",
	"ngrok-free.app",
	"duckdns.org",
	"no-ip.org",
	"ddns.net",
	"blogspot.com",
	"wordpress.com",
	"neocities.org",
	"surge.sh",
	"deno.dev",
	"supabase.co",
	"r2.dev",
]);

const settingEntry = /^\{setting:([a-z0-9_.-]{1,64})\}$/i;
/** The setting key of a `{setting:<key>}` entry, or undefined */
export const settingKeyOf = (entry: unknown): string | undefined =>
	typeof entry === "string" ? settingEntry.exec(entry.trim())?.[1] : undefined;

/** The rule an entry stands for, or undefined if it isn't a valid host entry (a `{setting:}` entry isn't one) */
export const parseHostEntry = (entry: unknown): HostRule | undefined => {
	if (typeof entry !== "string" || entry.length > 260) return undefined;
	// A path of URL path characters only (RFC 3986), without `;`, `,` and `'`: it goes into the CSP header as it is, where
	// those would start another directive or policy
	// Scheme and host in any case; the path as written (CSP and the URL parser match paths case-sensitively)
	const match = /^(?:([a-z]+):\/\/)?(\*\.)?([^:/?#@\s*]+)(?::(\d{1,5}))?(\/[a-z0-9\-._~!$&()*+=:@%/]*)?$/i.exec(entry.trim());
	if (match === null) return undefined;
	const [, rawScheme, star, rawHost, port, rawPath] = match;
	const scheme = rawScheme?.toLowerCase();
	const host = rawHost.toLowerCase();
	// A path as the URL parser writes it: no dot segments, no `%2e` that it would turn into one
	if (
		rawPath !== undefined &&
		(/(^|\/)\.{1,2}(\/|$)/.test(rawPath) || /%2e/i.test(rawPath) || /%(?![0-9a-f]{2})/.test(rawPath) || rawPath.includes("//"))
	)
		return undefined;
	// `/` alone or `/*` is any path
	const path = rawPath === undefined || rawPath === "/" || rawPath === "/*" ? "" : rawPath;
	if (star !== undefined && publicSuffixes.has(host)) return undefined;
	if (scheme !== undefined && !schemesAllowed.has(scheme)) return undefined;
	const isIp = ipv4.test(host);
	// The URL parser reads `010` as octal: such an entry would never match what it looks like
	if (isIp && host.split(".").some((part) => Number(part) > 255 || (part.length > 1 && part.startsWith("0")))) return undefined;
	// "localhost" is the one single-label name allowed; a wildcard needs a name of two labels or more under it
	if (!isIp && host !== "localhost" && !dnsName.test(host)) return undefined;
	// A name ending in a number is an IPv4 address to the URL parser: `*.1.1` would match 192.168.1.1
	if (!isIp && /^(\d+|0x[\da-f]*)$/.test(host.slice(host.lastIndexOf(".") + 1))) return undefined;
	if (star !== undefined && (isIp || host === "localhost")) return undefined;
	if (port !== undefined && (Number(port) < 1 || Number(port) > 65535 || port.startsWith("0"))) return undefined;
	const schemes = scheme === undefined ? defaultSchemes : [scheme];
	return { schemes, host, wildcard: star !== undefined, port: port ?? "", path };
};

/** An entry with its scheme, host and port in lower case and its path as written */
export const normalEntry = (entry: string) => entry.trim().replace(/^(?:[a-z]+:\/\/)?[^/]*/i, (origin) => origin.toLowerCase());

/** A valid entry: a host entry or a `{setting:<key>}` */
export const validEntry = (entry: unknown) => parseHostEntry(entry) !== undefined || settingKeyOf(entry) !== undefined;

/**
 * The entry for a setting's value (`{setting:<key>}`), or undefined if it holds no usable url or host. A url gives its
 * exact scheme, host and port (`http://nas.lan:8096` -> `http://nas.lan:8096`); a bare name gives https and wss to it
 */
export const settingValueEntry = (value: unknown): string | undefined => {
	if (typeof value !== "string" || value.trim() === "" || value.length > 2048) return undefined;
	const text = value.trim();
	let entry = text;
	if (/^[a-z]+:\/\//i.test(text)) {
		let url: URL;
		try {
			url = new URL(text);
		} catch {
			return undefined;
		}
		if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username !== "" || url.password !== "") return undefined;
		entry = `${url.protocol}//${url.hostname}${url.port === "" ? "" : `:${url.port}`}`;
	}
	const rule = parseHostEntry(entry);
	// A setting names one server: no wildcard, no path pattern
	return rule === undefined || rule.wildcard || rule.path !== "" ? undefined : entry.toLowerCase();
};

/**
 * The entries with each `{setting:<key>}` replaced by the entry its value stands for (dropped while it holds none).
 * `settings` marks which of the results came from a setting
 */
export const resolveSettings = (hosts: string[], valueOf: (key: string) => unknown): { hosts: string[]; settings: string[] } => {
	const resolved: string[] = [];
	const settings: string[] = [];
	for (const entry of hosts) {
		const key = settingKeyOf(entry);
		if (key === undefined) {
			if (!resolved.includes(entry)) resolved.push(entry);
			continue;
		}
		const value = settingValueEntry(valueOf(key));
		if (value === undefined) continue;
		if (!settings.includes(value)) settings.push(value);
		if (!resolved.includes(value)) resolved.push(value);
	}
	return { hosts: resolved, settings };
};

/**
 * A `{setting:<key>}` entry's value: `<key>` in the plugin storage named like the package, or else, for `<store>.<key>`,
 * `<key>` in the storage `<store>`
 */
export const settingValueOf = async (
	key: string,
	packageName: string,
	storage: (name: string) => Promise<Record<string, unknown> | undefined>,
) => {
	const own = (await storage(packageName))?.[key];
	const dot = key.indexOf(".");
	return own !== undefined || dot <= 0 ? own : (await storage(key.slice(0, dot)))?.[key.slice(dot + 1)];
};

/** The setting keys a list names */
export const settingKeys = (hosts: string[]) => hosts.map(settingKeyOf).filter((key): key is string => key !== undefined);

/** A path pattern matches the url's path: `*` is any characters, everything else literal */
const pathMatches = (pattern: string, pathname: string) => {
	if (pattern === "") return true;
	const path = pathname;
	const parts = pattern.split("*");
	if (parts.length === 1) return path === pattern;
	if (!path.startsWith(parts[0])) return false;
	let at = parts[0].length;
	for (let i = 1; i < parts.length - 1; i++) {
		const found = path.indexOf(parts[i], at);
		if (found === -1) return false;
		at = found + parts[i].length;
	}
	const last = parts[parts.length - 1];
	return path.length - last.length >= at && path.endsWith(last);
};

export type DeclaredHosts = {
	/** Valid entries, normalized (trimmed, scheme and host in lower case), without duplicates */
	hosts: string[];
	/** Entries that aren't valid: they allow nothing */
	invalid: string[];
};

/** A package's `hosts`, or undefined if it declares none (compatibility mode). `[]` declares no network at all */
export const declaredHosts = (value: unknown): DeclaredHosts | undefined => {
	if (!Array.isArray(value)) return undefined;
	const hosts: string[] = [];
	const invalid: string[] = [];
	for (const entry of value.slice(0, 200)) {
		if (!validEntry(entry)) invalid.push(String(entry).slice(0, 80));
		else {
			const key = settingKeyOf(entry);
			const normalized = key !== undefined ? `{setting:${key}}` : normalEntry(entry as string);
			if (!hosts.includes(normalized)) hosts.push(normalized);
		}
	}
	return { hosts, invalid };
};

/** Two packages declare the same hosts (both none counts as the same) */
export const sameHosts = (a: unknown, b: unknown) => {
	const left = declaredHosts(a);
	const right = declaredHosts(b);
	if (left === undefined || right === undefined) return left === right;
	return left.hosts.length === right.hosts.length && left.hosts.every((host) => right.hosts.includes(host));
};

/** Hosts an update adds and removes. Going from no `hosts` to a list, or back, adds or removes nothing here */
export const hostsDiff = (accepted: string[], pending: string[]) => ({
	added: pending.filter((host) => !accepted.includes(host)),
	removed: accepted.filter((host) => !pending.includes(host)),
});

const ruleMatches = (rule: HostRule, url: URL) => {
	const scheme = url.protocol.slice(0, -1);
	if (!rule.schemes.includes(scheme)) return false;
	const port = url.port === "" ? defaultPort[scheme] : url.port;
	if (port !== (rule.port === "" ? defaultPort[scheme] : rule.port)) return false;
	const host = url.hostname;
	if (!(rule.wildcard ? host.endsWith(`.${rule.host}`) : host === rule.host)) return false;
	return pathMatches(rule.path, url.pathname);
};

/** The url's scheme, host and port are in one of the entries */
export const hostAllowed = (hosts: string[], url: URL) =>
	hosts.some((entry) => {
		const rule = parseHostEntry(entry);
		return rule !== undefined && ruleMatches(rule, url);
	});

/** The entry names a local address or name (`localhost`, `127.0.0.1`, `*.home.arpa`, `nas.lan`): the user sees that it's local */
export const isLocalEntry = (entry: string) => {
	const rule = parseHostEntry(entry);
	return rule !== undefined && isLocalHost(rule.host);
};

/**
 * A local entry of the list matches the url. Only such an entry lets luna.fetch reach a local address: a public name in
 * the list that resolves to one is refused like in compatibility mode
 */
export const localEntryAllows = (hosts: string[], url: URL) =>
	hosts.some((entry) => {
		const rule = parseHostEntry(entry);
		return rule !== undefined && isLocalHost(rule.host) && ruleMatches(rule, url);
	});

// Names only a local network answers for (RFC 6761/6762/8375 and common router defaults)
const privateSuffixes = ["localhost", "local", "lan", "home", "home.arpa", "internal", "intranet", "corp", "localdomain", "private"];

/**
 * A host luna.fetch never reaches for a plugin in compatibility mode: loopback, private and link-local addresses, and
 * names for them. Unlike a fetch from the page, luna.fetch runs in the main process without CORS, so it could read the
 * answers of services on this computer or network. A plugin that needs one names it in `hosts`.
 * Addresses, single-label names (`http://router/`) and the usual private suffixes. A public name that resolves to a
 * private address is checked by net.ts once resolved.
 */
export const isLocalHost = (hostname: string): boolean => {
	const host = hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
	if (host === "" || privateSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;
	if (!host.includes(".") && !host.includes(":")) return true;
	const v4 = ipv4.exec(host);
	if (v4 !== null) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	if (host.includes(":")) {
		const g = ipv6Groups(host);
		// Not an address we can read: refused rather than guessed
		if (g === undefined) return true;
		// Unique local fc00::/7, link-local fe80::/10
		if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80) return true;
		// Site-local fec0::/10 (deprecated) and the local-use NAT64 prefix 64:ff9b:1::/48
		if ((g[0] & 0xffc0) === 0xfec0 || (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1)) return true;
		const v4 = (high: number, low: number) => isLocalHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
		const zero = (from: number, to: number) => g.slice(from, to).every((group) => group === 0);
		// IPv4-compatible (::a.b.c.d, also :: and ::1) and IPv4-mapped (::ffff:a.b.c.d)
		if (zero(0, 5) && (g[5] === 0 || g[5] === 0xffff)) return v4(g[6], g[7]);
		// IPv4-translated ::ffff:0:a.b.c.d
		if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]);
		// NAT64 64:ff9b::a.b.c.d
		if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]);
		// Teredo 2001:0::/32: the client address, inverted, in the last two groups
		if (g[0] === 0x2001 && g[1] === 0) return v4(g[6] ^ 0xffff, g[7] ^ 0xffff);
		// 6to4 2002:aabb:ccdd::
		if (g[0] === 0x2002) return v4(g[1], g[2]);
		return false;
	}
	return false;
};

/**
 * The 8 groups of an IPv6 address, in any form: compressed (`2002:a01::1`), or with a dotted IPv4 tail (`::127.0.0.1`,
 * as dns.lookup writes it). Undefined if it isn't one
 */
const ipv6Groups = (address: string): number[] | undefined => {
	let text = address;
	const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
	if (dotted !== null) {
		const [a, b, c, d] = dotted.slice(2).map(Number);
		if ([a, b, c, d].some((part) => part > 255)) return undefined;
		text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return undefined;
	const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => (/^[\da-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)));
	const head = parse(halves[0]);
	const tail = halves.length === 2 ? parse(halves[1]) : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
	const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
	return groups.some(Number.isNaN) ? undefined : groups;
};

/**
 * The CSP of every plugin world (coreWorld.ts sets it with setIsolatedWorldInfo). The world's own fetch, XMLHttpRequest,
 * WebSocket, sendBeacon, import() and the images, scripts and styles it puts into the page are blocked: luna.fetch
 * (`__LunaNative.fetch`, checked against the plugin's hosts in main) is its way out. `'unsafe-eval'`: libraries that
 * build functions still run, that needs no network.
 * Not a boundary while the page's own CSP blocks nothing: what the world writes into the page's DOM that runs or loads in
 * the page (an inline `onerror=` handler, an iframe, a style attribute's url()) is the page's request, not the world's.
 */
export const worldCsp = "default-src 'none'; script-src 'unsafe-eval'";

/** CSP source expressions for the entries (cspReportOnly.ts adds them to the network directives) */
export const cspSources = (hosts: string[]): string[] => {
	const sources = new Set<string>();
	for (const entry of hosts) {
		const rule = parseHostEntry(entry);
		if (rule === undefined) continue;
		// CSP matches a path ending in `/` as a prefix: the part before the first `*`, cut back to its last `/`. Wider
		// than the pattern, which net.ts checks exactly
		const path =
			rule.path === ""
				? ""
				: rule.path.includes("*")
					? rule.path.slice(0, rule.path.slice(0, rule.path.indexOf("*")).lastIndexOf("/") + 1)
					: rule.path;
		const host = `${rule.wildcard ? "*." : ""}${rule.host}${rule.port === "" ? "" : `:${rule.port}`}${path === "/" ? "" : path}`;
		for (const scheme of rule.schemes) sources.add(`${scheme}://${host}`);
	}
	return [...sources];
};
