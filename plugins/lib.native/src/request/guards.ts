import { extname } from "path";

/** Media is only fetched from TIDAL over https. Callable from the renderer, so no other hosts, local addresses or data: urls */
export const assertTidalUrl = (url: string) => {
	const { protocol, hostname, origin } = new URL(url);
	if (protocol !== "https:" || !(hostname === "tidal.com" || hostname.endsWith(".tidal.com"))) throw new Error(`Blocked non TIDAL url ${origin}`);
	return url;
};

/** A redirect must stay on TIDAL too */
export const assertTidalRedirect = (res: Response) => {
	if (res.redirected) assertTidalUrl(res.url);
	return res;
};
export const fetchTidal = async (url: string, init?: RequestInit) => assertTidalRedirect(await fetch(assertTidalUrl(url), init));

const mediaExtensions = new Set([".flac", ".m4a", ".mp4", ".mp3", ".aac", ".ogg", ".opus", ".wav"]);
/** Downloads are only written as media files, never e.g. scripts or shortcuts */
export const assertMediaFile = (path: string) => {
	if (!mediaExtensions.has(extname(path).toLowerCase())) throw new Error(`Blocked download to non media file ${path}`);
	return path;
};
