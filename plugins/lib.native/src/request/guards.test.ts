import { describe, expect, test } from "vitest";

import { assertMediaFile, assertTidalRedirect, assertTidalUrl } from "./guards";

describe("assertTidalUrl", () => {
	test("allows TIDAL's https hosts", () => {
		for (const url of [
			"https://sp-ad-fa.audio.tidal.com/mediatracks/x/0.mp4?token=a~b==",
			"https://lgf.audio.tidal.com/x.flac",
			"https://resources.tidal.com/images/x/1280x1280.jpg",
		])
			expect(assertTidalUrl(url)).toBe(url);
	});

	test("blocks other urls", () => {
		for (const url of [
			"data:text/plain;base64,QA==",
			"http://sp-ad-fa.audio.tidal.com/x",
			"https://tidal.com.example.com/x",
			"https://eviltidal.com/x",
			"https://127.0.0.1/x",
			"file:///C:/x",
			"not a url",
		])
			expect(() => assertTidalUrl(url), url).toThrow();
	});
});

describe("assertMediaFile", () => {
	test("allows media files only", () => {
		for (const path of ["C:\\Music\\a.flac", "/home/u/Music/a.M4A", "a.mp4"]) expect(assertMediaFile(path)).toBe(path);
		for (const path of ["C:\\x\\poc.cmd", "a.flac.lnk", "/home/u/.bashrc", "a.desktop", "a", "a.js"])
			expect(() => assertMediaFile(path), path).toThrow();
	});
});

describe("assertTidalRedirect", () => {
	test("blocks redirects away from TIDAL", () => {
		const res = (url: string, redirected: boolean) => ({ url, redirected }) as Response;
		expect(assertTidalRedirect(res("http://127.0.0.1:1/x", false))).toBeTruthy();
		expect(assertTidalRedirect(res("https://lgf.audio.tidal.com/x", true))).toBeTruthy();
		expect(() => assertTidalRedirect(res("https://example.com/x", true))).toThrow();
	});
});
