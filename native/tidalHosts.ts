/** Hosts that serve the TIDAL web client. Luna only loads into pages on these */
export const tidalMainHosts = new Set(["listen.tidal.com", "tidal.com", "desktop.tidal.com", "stage.tidal.com"]);

// Both hosts serve the same api, TIDAL uses api. and Luna desktop.
const apiHosts = new Set(["api.tidal.com", "desktop.tidal.com"]);
/** Host + path a request is cached under, the same for both api hosts. Shared by render/src/SharedRequests and native/OfflineResponses */
export const tidalRequestPath = (url: URL) =>
	`${apiHosts.has(url.hostname) && /^\/v[12]\//.test(url.pathname) ? "tidal-v1" : url.host}${url.pathname}`;
/** `tidalRequestPath` with the query sorted */
export const tidalRequestKey = (url: URL) => {
	const search = new URLSearchParams(url.search);
	search.sort();
	return `${tidalRequestPath(url)}?${search}`;
};
