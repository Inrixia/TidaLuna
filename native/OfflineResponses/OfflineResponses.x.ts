import { tidalMainHosts } from "../tidalHosts";

// What the page renders from. Leaves out audio/video (AudioStreams keeps audio) and anything streamed (an event stream never ends)
export const cacheableType = /json|javascript|text\/(?!event-stream)|image\/|font/;
// Headers that describe the original transfer, not the body the page gets
export const droppedHeaders = new Set(["set-cookie", "content-encoding", "content-length", "transfer-encoding"]);
// Headers a replay needs: what the body is and the CORS headers the page checks
export const keptHeader = /^(content-type|access-control-)/i;

export const isTidalApi = (url: URL) =>
	url.hostname === "api.tidal.com" ||
	url.hostname === "openapi.tidal.com" ||
	(tidalMainHosts.has(url.hostname) && /^\/v[12]\//.test(url.pathname));
export const isTidalHost = (url: URL) => url.hostname === "tidal.com" || url.hostname.endsWith(".tidal.com");

export const json = (status: number, statusText: string, body: object) =>
	new Response(JSON.stringify(body), {
		status,
		statusText,
		headers: { "content-type": "application/json", date: new Date().toUTCString(), "x-luna-offline-miss": "1" },
	});
