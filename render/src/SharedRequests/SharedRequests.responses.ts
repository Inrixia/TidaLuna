/** A response as received, kept so it can be served again */
export type RawResponse = { status: number; statusText: string; headers: Headers; etag: string | null; body: string };

/** Reads `res` into a `RawResponse` without consuming it for its caller */
export const readRaw = async (res: Response): Promise<RawResponse> => {
	// Cloned synchronously, before the caller's handlers can read the body
	const clone = res.clone();
	return { status: res.status, statusText: res.statusText, headers: res.headers, etag: res.headers.get("etag"), body: await clone.text() };
};

/** The json of a response, `undefined` for an item that doesn't exist or isn't available (403 / 404) */
export const parse = (raw: RawResponse) => {
	if (raw.status >= 200 && raw.status < 300) return JSON.parse(raw.body);
	// The offline cache's 404 for what it doesn't hold is not an answer
	if (!raw.headers.has("x-luna-offline-miss") && (raw.status === 403 || raw.status === 404)) return undefined;
	throw new Error(`${raw.status} ${raw.statusText}`);
};

// Some apis (openapi playlist items) return the same json with keys in another order
const sortedKeys = (_: string, value: unknown) => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) sorted[key] = (<Record<string, unknown>>value)[key];
	return sorted;
};
const sameJson = (a: string, b: string) => {
	try {
		return JSON.stringify(JSON.parse(a), sortedKeys) === JSON.stringify(JSON.parse(b), sortedKeys);
	} catch {
		return false;
	}
};
/** Whether a re-fetch returned what is cached, so nothing needs re-rendering */
export const sameResponse = (a: RawResponse, b: RawResponse) =>
	a.status === b.status && ((a.etag !== null && a.etag === b.etag) || a.body === b.body || sameJson(a.body, b.body));

/** A `Response` for the page from `body`, with the url it answers */
export const toResponse = (url: URL, body: string, init: ResponseInit) => {
	const res = new Response(body, init);
	Object.defineProperty(res, "url", { value: url.href });
	return res;
};
