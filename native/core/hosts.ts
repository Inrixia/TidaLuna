// A plugin's `hosts`: the network hosts its package.json says it connects to. The user accepts them with the plugin's
// version (registry.ts shows them in the install and update confirmations), and luna.fetch (net.ts) refuses any other
// host for that plugin. A plugin without `hosts` runs in compatibility mode: luna.fetch lets it reach any public host and
// marks those requests in the log.
//
// An entry is `[scheme://]host[:port]`:
// - `api.example.com`: https and wss to that host, default ports;
// - `*.example.com`: any subdomain of example.com (not example.com itself);
// - `http://127.0.0.1:8080`: only that scheme and port. http and ws need the scheme written out.
// Kept apart from Electron so it can be tested.

export type HostRule = { schemes: string[]; host: string; wildcard: boolean; port: string };

const schemesAllowed = new Set(["http", "https", "ws", "wss"]);
const defaultSchemes = ["https", "wss"];
const defaultPort: Record<string, string> = { http: "80", ws: "80", https: "443", wss: "443" };

const label = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const dnsName = new RegExp(`^${label}(\\.${label})+$`);
const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The rule an entry stands for, or undefined if it isn't a valid entry */
export const parseHostEntry = (entry: unknown): HostRule | undefined => {
	if (typeof entry !== "string" || entry.length > 260) return undefined;
	const match = /^(?:([a-z]+):\/\/)?(\*\.)?([^:/?#@\s]+)(?::(\d{1,5}))?$/.exec(entry.trim().toLowerCase());
	if (match === null) return undefined;
	const [, scheme, star, host, port] = match;
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
	return { schemes, host, wildcard: star !== undefined, port: port ?? "" };
};

export type DeclaredHosts = {
	/** Valid entries, normalized (lower case, trimmed), without duplicates */
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
		if (parseHostEntry(entry) === undefined) invalid.push(String(entry).slice(0, 80));
		else {
			const normalized = (entry as string).trim().toLowerCase();
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
	return rule.wildcard ? host.endsWith(`.${rule.host}`) : host === rule.host;
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
		const v4 = (high: number, low: number) => isLocalHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
		const zero = (from: number, to: number) => g.slice(from, to).every((group) => group === 0);
		// IPv4-compatible (::a.b.c.d, also :: and ::1) and IPv4-mapped (::ffff:a.b.c.d)
		if (zero(0, 5) && (g[5] === 0 || g[5] === 0xffff)) return v4(g[6], g[7]);
		// NAT64 64:ff9b::a.b.c.d
		if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]);
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

/** CSP source expressions for the entries (cspReportOnly.ts adds them to the network directives) */
export const cspSources = (hosts: string[]): string[] => {
	const sources = new Set<string>();
	for (const entry of hosts) {
		const rule = parseHostEntry(entry);
		if (rule === undefined) continue;
		const host = `${rule.wildcard ? "*." : ""}${rule.host}${rule.port === "" ? "" : `:${rule.port}`}`;
		for (const scheme of rule.schemes) sources.add(`${scheme}://${host}`);
	}
	return [...sources];
};
