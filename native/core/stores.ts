// Where Luna reads plugin stores and plugins from. With the strict network the page's connect-src lists these origins
// (injector.ts), so Luna's UI can read store.json and a plugin's package there; and main fetches a plugin to install or
// to move to only from them (registry.ts): otherwise page code could reach any host by naming it as a plugin url.
import { hostAllowed } from "./hosts";
import { isDevUrl } from "./policy";

/** Luna's own default stores that aren't on GitHub (plugins/ui PluginStoreTab), and its local dev store */
export const defaultStoreOrigins = ["https://release.radiant-lyrics.org", "http://127.0.0.1:3000"];

/** The origin a store or plugin url is read from; undefined for anything but plain http(s) */
export const storeOriginOf = (url: unknown): string | undefined => {
	if (typeof url !== "string") return undefined;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
		if (parsed.username !== "" || parsed.password !== "") return undefined;
		return parsed.origin;
	} catch {
		return undefined;
	}
};

/**
 * A url Luna may read a plugin or store from: one of `origins`, an https url on a host of the page's baseline (GitHub
 * releases and raw files), or a dev plugin on this computer (`http://127.0.0.1`, policy.ts isDevUrl)
 */
export const storeUrlAllowed = (url: string, origins: Iterable<string>, baselineHosts: string[]): boolean => {
	const origin = storeOriginOf(url);
	if (origin === undefined) return false;
	if (isDevUrl(url)) return true;
	for (const allowed of origins) if (allowed === origin) return true;
	return origin.startsWith("https:") && hostAllowed(baselineHosts, new URL(url));
};
