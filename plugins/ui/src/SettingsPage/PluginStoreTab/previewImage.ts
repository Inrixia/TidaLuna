// The store renders a card for every plugin of every listed store, so an unrestricted image url
// would let any listed author log the IP of everyone who opens the tab. Limited to the GitHub hosts
// the plugin code already comes from, anything else is ignored and the card falls back to plain.
const ALLOWED_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "user-images.githubusercontent.com", "objects.githubusercontent.com"]);

export const previewImageUrl = (image: unknown): string | undefined => {
	if (typeof image !== "string" || image === "") return undefined;
	let url: URL;
	try {
		url = new URL(image);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:") return undefined;
	if (!ALLOWED_HOSTS.has(url.hostname)) return undefined;
	return url.href;
};

/** Per plugin wins, otherwise the store wide default, otherwise off. */
export const showDownloadsFor = (pluginFlag: unknown, storeFlag: unknown): boolean =>
	typeof pluginFlag === "boolean" ? pluginFlag : storeFlag === true;
