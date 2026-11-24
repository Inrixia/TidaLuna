// TIDAL's audio urls: https://<host>.audio.tidal.com/<path>?token=<expiry epoch seconds>~<signature>
import { createHash } from "crypto";

const audioHost = /^[\w-]+\.audio\.tidal\.com$/;

/** The id of the audio at `rawUrl`, by its path (the token changes). `undefined` if it isn't a TIDAL audio url */
export const audioIdOf = (rawUrl: string) => {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return;
	}
	if (url.protocol !== "https:" || !audioHost.test(url.hostname)) return;
	return createHash("sha1").update(url.pathname).digest("hex").slice(0, 32);
};

/** When the token of `rawUrl` expires, epoch seconds. 0 if it has none */
export const expiryOf = (rawUrl: string) => Number(new URL(rawUrl).searchParams.get("token")?.split("~")[0]) || 0;
