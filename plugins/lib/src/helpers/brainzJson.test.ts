import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { brainzJson } from "./brainzJson";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("brainzJson", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	test("returns the parsed body", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ id: "abc" }));
		await expect(brainzJson("https://musicbrainz.org/ws/2/x")).resolves.toEqual({ id: "abc" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("retries a busy server (503) and succeeds", async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ error: "busy" }, 503))
			.mockResolvedValueOnce(jsonResponse({ error: "busy" }, 503))
			.mockResolvedValueOnce(jsonResponse({ error: "busy" }, 503))
			.mockResolvedValueOnce(jsonResponse({ id: "abc" }));

		const promise = brainzJson("https://musicbrainz.org/ws/2/x");
		// Each retry waits 500ms
		await vi.advanceTimersByTimeAsync(1500);
		await expect(promise).resolves.toEqual({ id: "abc" });
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	test("does not retry more than three times and rejects when still busy", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: "busy" }, 503));

		const promise = brainzJson("https://musicbrainz.org/ws/2/x");
		// The assertion has to observe the rejection, so attach it before the timers run
		const settled = promise.catch((err: Error) => err);
		await vi.advanceTimersByTimeAsync(1500);

		await expect(settled).resolves.toBeInstanceOf(Error);
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	test("rejects on a non-ok response without retrying", async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
		await expect(brainzJson("https://musicbrainz.org/ws/2/x")).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("serialises concurrent calls, one request at a time", async () => {
		let inFlight = 0;
		let peak = 0;
		fetchMock.mockImplementation(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Promise.resolve();
			inFlight--;
			return jsonResponse({ ok: true });
		});

		await Promise.all([brainzJson("https://musicbrainz.org/a"), brainzJson("https://musicbrainz.org/b"), brainzJson("https://musicbrainz.org/c")]);

		expect(peak).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
