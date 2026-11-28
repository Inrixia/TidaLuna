import { afterEach, describe, expect, test, vi } from "vitest";

import { downloadObject } from "./downloadObject";

/**
 * `downloadObject` is the click of a detached anchor: what it does is the Blob it builds, the object URL it makes of
 * it, the anchor it clicks and the revoke that follows. The blob URL functions are stubbed so the test can assert on
 * the Blob it made instead of depending on the environment's URL backend.
 */
const stubObjectUrls = () => {
	const events: string[] = [];
	const created: Blob[] = [];
	const clicked: HTMLAnchorElement[] = [];
	const url = "blob:luna-download";
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
		events.push("create");
		created.push(blob as Blob);
		return url;
	});
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
		events.push("click");
		clicked.push(this);
	});
	const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {
		events.push("revoke");
	});
	return { events, created, clicked, revokeObjectURL, url };
};

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("downloadObject", () => {
	test("makes a blob of the content with the given type and clicks an anchor for it as a download", async () => {
		const { created, clicked, url } = stubObjectUrls();

		downloadObject("name,plays\nSong,3", "luna.csv", "text/csv");

		expect(created).toHaveLength(1);
		expect(created[0].type).toBe("text/csv");
		expect(await created[0].text()).toBe("name,plays\nSong,3");
		expect(clicked).toHaveLength(1);
		expect(clicked[0].download).toBe("luna.csv");
		expect(clicked[0].href).toBe(url);
	});

	test("revokes the object URL after the click, not during it", () => {
		vi.useFakeTimers();
		try {
			const { events, revokeObjectURL, url } = stubObjectUrls();

			downloadObject("<h1>Luna</h1>", "luna.html", "text/html");

			// Still alive when the click is handled: revoking here can abort the download in Chromium
			expect(events).toEqual(["create", "click"]);
			expect(revokeObjectURL).not.toHaveBeenCalled();

			vi.advanceTimersByTime(40_000);

			expect(revokeObjectURL).toHaveBeenCalledWith(url);
		} finally {
			vi.useRealTimers();
		}
	});

	test("clicks an anchor that is not in the document", () => {
		const { clicked } = stubObjectUrls();

		downloadObject("content", "luna.txt", "text/plain");

		// Detached anchors still download in Chromium, and the page TIDAL renders is left alone
		expect(clicked[0].parentNode).toBeNull();
		expect(document.querySelector("a")).toBeNull();
	});
});
