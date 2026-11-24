import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSource } from "./buildSource";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("a CI build names its commit and repository", () => {
	assert.deepEqual(buildSource({ GITHUB_SHA: SHA, GITHUB_SERVER_URL: "https://git.cafe", GITHUB_REPOSITORY: "me/plugins" }, {}), {
		commit: SHA,
		repository: { type: "git", url: "https://git.cafe/me/plugins" },
	});
});

test("keeps the package's own repository", () => {
	const env = { GITHUB_SHA: SHA, GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "o/r" };
	assert.deepEqual(buildSource(env, { repository: { url: "https://github.com/x/y" } }), { commit: SHA });
});

test("a local build or odd values add nothing", () => {
	assert.deepEqual(buildSource({}, {}), {});
	assert.deepEqual(buildSource({ GITHUB_SHA: "main", GITHUB_SERVER_URL: "http://github.com", GITHUB_REPOSITORY: "o/r/../x" }, {}), {});
});
