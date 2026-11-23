// luna.fetch requests and answers as they cross to the main process (native/core/net.ts), kept apart so they can be tested
import type { NetRequest, NetResponse } from "../../../native/core/net";

/** What fetch takes, as luna.fetch sends it to the main process. Streamed bodies are read first */
export const toNetRequest = async (input: string | URL | Request, init?: RequestInit): Promise<NetRequest> => {
	const request = new Request(input, init);
	const bytes = request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer());
	return {
		url: request.url,
		method: request.method,
		headers: Object.fromEntries(request.headers),
		body: bytes === undefined || bytes.byteLength === 0 ? undefined : bytes,
	};
};

// Statuses a Response can't have a body with
const nullBodyStatuses = new Set([101, 103, 204, 205, 304]);

/** The main process's answer as a Response */
export const toResponse = (res: NetResponse): Response => {
	const response = new Response(nullBodyStatuses.has(res.status) ? null : (res.body as BodyInit), {
		status: res.status < 200 ? 200 : res.status,
		statusText: res.statusText,
		headers: res.headers,
	});
	Object.defineProperty(response, "url", { value: res.url });
	Object.defineProperty(response, "redirected", { value: res.redirected });
	return response;
};
