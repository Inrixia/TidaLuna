// Run: pnpm exec tsx --test plugins/lib.native/src/request/guards.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { assertMediaFile, assertTidalRedirect, assertTidalUrl } from "./guards";

test("assertTidalUrl allows TIDAL's https hosts", () => {
	for (const url of [
		"https://sp-ad-fa.audio.tidal.com/mediatracks/x/0.mp4?token=a~b==",
		"https://lgf.audio.tidal.com/x.flac",
		"https://resources.tidal.com/images/x/1280x1280.jpg",
	])
		assert.equal(assertTidalUrl(url), url);
});

test("assertTidalUrl blocks other urls", () => {
	for (const url of [
		"data:text/plain;base64,QA==",
		"http://sp-ad-fa.audio.tidal.com/x",
		"https://tidal.com.example.com/x",
		"https://eviltidal.com/x",
		"https://127.0.0.1/x",
		"file:///C:/x",
		"not a url",
	])
		assert.throws(() => assertTidalUrl(url), url);
});

test("assertMediaFile allows media files only", () => {
	for (const path of ["C:\\Music\\a.flac", "/home/u/Music/a.M4A", "a.mp4"]) assert.equal(assertMediaFile(path), path);
	for (const path of ["C:\\x\\poc.cmd", "a.flac.lnk", "/home/u/.bashrc", "a.desktop", "a", "a.js"]) assert.throws(() => assertMediaFile(path), path);
});

test("assertTidalRedirect blocks redirects away from TIDAL", () => {
	const res = (url: string, redirected: boolean) => ({ url, redirected }) as Response;
	assert.ok(assertTidalRedirect(res("http://127.0.0.1:1/x", false)));
	assert.ok(assertTidalRedirect(res("https://lgf.audio.tidal.com/x", true)));
	assert.throws(() => assertTidalRedirect(res("https://example.com/x", true)));
});
