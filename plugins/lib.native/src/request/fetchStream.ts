import { rejectNotOk } from "@inrixia/helpers";
import type { Decipher } from "crypto";

export type FetchProgress = { readonly total?: number; readonly downloaded?: number };
export type TrackStreamOptions = {
	progress?: FetchProgress;
	reqInit?: RequestInit;
	bytesWanted?: number;
	decipher?: Decipher;
};

const parseTotal = (headers: Response["headers"]) => {
	const contentRange = headers.get("content-range");
	if (contentRange !== null) {
		// Server supports byte range, parse total file size from header
		const match = /\/(\d+)$/.exec(contentRange);
		if (match) return parseInt(match[1], 10);
	} else {
		const contentLength = headers.get("content-length");
		if (contentLength !== null) return parseInt(contentLength, 10);
	}
	return 0;
};

export async function* fetchStream(urls: string[], options: TrackStreamOptions = {}) {
	options.progress ??= {};
	// Clear these just to be safe
	(options.progress.total as number) = 0;
	(options.progress.downloaded as number) = 0;

	options.reqInit ??= {};

	let { progress, bytesWanted, decipher, reqInit } = options;

	reqInit.headers = new Headers(reqInit.headers);
	const partialRequest = bytesWanted !== undefined;
	if (urls.length === 1 && partialRequest) reqInit.headers.set("Range", `bytes=0-${bytesWanted}`);

	try {
		for (const url of urls) {
			const res = await fetch(url, reqInit).then(rejectNotOk);
			(progress.total as number) += parseTotal(res.headers);
			const reader = res.body?.getReader();
			if (!reader) continue;
			while (true) {
				let { done, value } = await reader.read();
				if (done) break;

				if (decipher) value = decipher.update(value!);
				(progress.downloaded as number) += value!.length;

				yield value;

				if (partialRequest && progress.downloaded! >= bytesWanted) return reader.cancel();
			}
			if (partialRequest && progress.downloaded! >= bytesWanted) return;
		}
	} finally {
		if (decipher) {
			const decipherEnd = decipher.final();
			(progress.downloaded as number) += decipherEnd.length;

			yield decipherEnd;
		}
	}
}
