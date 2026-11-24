// Answering HTTP range requests (RFC 9110 14), for serving audio to players that seek
import type http from "http";

import type { Range } from "../../cache";

/** The inclusive byte range a `Range: bytes=` header asks of `size` bytes, `undefined` if there is none or it can't be satisfied */
export const parseRange = (header: string | undefined, size: number): Range | undefined => {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
	if (match === null) return;
	// `bytes=-n` is the last n bytes, `bytes=n-` from n to the end
	let start = match[1] === "" ? size - Number(match[2]) : Number(match[1]);
	const end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	start = Math.max(0, start);
	if (start > end) return;
	return [start, end];
};

/** Answers the head of a request for `size` bytes: 200, 206 for a range, 416 (ending it) if the range can't be satisfied. Returns the inclusive range to send */
export const writeHead = (
	req: http.IncomingMessage,
	res: http.ServerResponse,
	size: number,
	headers: http.OutgoingHttpHeaders,
): Range | undefined => {
	const rangeHeader = req.headers.range;
	const range = parseRange(rangeHeader, size);
	if (rangeHeader !== undefined && range === undefined) return void res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
	const [start, end] = range ?? [0, size - 1];
	headers["Content-Length"] = end - start + 1;
	headers["Accept-Ranges"] = "bytes";
	if (range !== undefined) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
	res.writeHead(range ? 206 : 200, headers);
	return [start, end];
};
