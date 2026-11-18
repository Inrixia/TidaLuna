import { rejectNotOk, toJson } from "@inrixia/helpers";

// MusicBrainz allows about one request per second and answers 503 when it's busy, see https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
const requestInterval = 1000;
const busyRetries = 3;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let queue: Promise<void> = Promise.resolve();

/**
 * Fetch json from the MusicBrainz API, one request at a time and retrying when the server is busy.
 */
export const brainzJson = <T>(url: string): Promise<T> => {
	const request = queue.then(async () => {
		for (let retry = 1; ; retry++) {
			const res = await fetch(url);
			if ((res.status !== 503 && res.status !== 429) || retry > busyRetries) return toJson<T>(rejectNotOk(res));
			await wait(requestInterval * 2 ** retry);
		}
	});
	queue = request.then(
		() => wait(requestInterval),
		() => wait(requestInterval),
	);
	return request;
};
