/**
 * With the strict network, TIDAL's page reads stores, plugins and themes only from origins Luna core knows
 * (native/core/stores.ts): its default stores, GitHub, the origins of installed plugins and the ones the user allowed.
 * For a url from another origin the user allows it first, in Luna's own window; the page can read it from its next load.
 * @returns "ready" (readable now), "reload" (allowed, readable once TIDAL reloads) or "denied"
 */
export const allowSource = async (url: string): Promise<"ready" | "reload" | "denied"> => {
	const { origin } = new URL(url);
	if ((await __LunaCore.pageStores()).includes(origin)) return "ready";
	if (!(await __LunaCore.allowStore(url))) return "denied";
	// GitHub and TIDAL's own hosts are readable without being listed
	return (await __LunaCore.storeOrigins()).includes(origin) ? "reload" : "ready";
};

export const reloadToRead = (url: string) => `Allowed ${new URL(url).origin}: reload TIDAL (Ctrl+R) to read from it`;
