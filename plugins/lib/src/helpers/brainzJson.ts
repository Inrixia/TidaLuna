import { rejectNotOk, Semaphore, sleep, toJson } from "@inrixia/helpers";

// MusicBrainz answers 503 when it's busy, see https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
const busyRetries = 3;
const busyDelay = 500;
const brainzSema = new Semaphore(1);

/**
 * Fetch json from the MusicBrainz API, one request at a time and retrying when the server is busy.
 */
export const brainzJson = <T>(url: string): Promise<T> =>
	brainzSema.with(async () => {
		for (let retry = 1; ; retry++) {
			const res = await fetch(url);
			if (res.status !== 503 || retry > busyRetries) return toJson<T>(rejectNotOk(res));
			await sleep(busyDelay);
		}
	});
