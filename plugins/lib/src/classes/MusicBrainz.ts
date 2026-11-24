import { rejectNotOk, Semaphore, sleep, toJson } from "@inrixia/helpers";

import type { Cache } from "@luna/core";

import { libTrace } from "../index.safe";

// MusicBrainz answers 503 when it's busy, see https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
const busyRetries = 3;
const busyDelayMs = 500;

/**
 * Json from the MusicBrainz API by url, one request at a time (retrying when the server is busy), and kept in `cache` across restarts.
 * Calls for a url in flight share one request. A failed request is not kept.
 */
export class MusicBrainz {
	private static readonly trace = libTrace.withSource(".MusicBrainz").trace;
	private readonly semaphore = new Semaphore(1);
	private readonly inFlight = new Map<string, Promise<unknown>>();

	public constructor(private readonly cache: Cache<any, any>) {}

	public json<T>(url: string): Promise<T> {
		let request = this.inFlight.get(url);
		if (request === undefined) {
			request = this.load(url).finally(() => this.inFlight.delete(url));
			this.inFlight.set(url, request);
		}
		return <Promise<T>>request;
	}

	private async load(url: string): Promise<unknown> {
		const cached = await this.cache.read(url);
		if (cached !== undefined) return cached;
		const json = await this.semaphore.with(async () => {
			for (let retry = 1; ; retry++) {
				const res = await fetch(url);
				if (res.status !== 503 || retry > busyRetries) return toJson<unknown>(rejectNotOk(res));
				await sleep(busyDelayMs);
			}
		});
		// Not waited on: the json is good even if keeping it fails
		this.cache.set(url, json, { write: "async" }).catch(MusicBrainz.trace.warn.withContext("json", url));
		return json;
	}
}
