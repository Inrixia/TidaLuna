import { expect, test } from "vitest";

import { buildSource } from "./buildSource";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("a CI build names its commit and repository", () => {
	expect(buildSource({ GITHUB_SHA: SHA, GITHUB_SERVER_URL: "https://git.cafe", GITHUB_REPOSITORY: "me/plugins" }, {})).toStrictEqual({
		commit: SHA,
		repository: { type: "git", url: "https://git.cafe/me/plugins" },
	});
});

test("keeps the package's own repository", () => {
	const env = { GITHUB_SHA: SHA, GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "o/r" };
	expect(buildSource(env, { repository: { url: "https://github.com/x/y" } })).toStrictEqual({ commit: SHA });
});

test("a local build or odd values add nothing", () => {
	expect(buildSource({}, {})).toStrictEqual({});
	expect(buildSource({ GITHUB_SHA: "main", GITHUB_SERVER_URL: "http://github.com", GITHUB_REPOSITORY: "o/r/../x" }, {})).toStrictEqual({});
});

test("a pull request or merge queue build names no commit", () => {
	expect(buildSource({ GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: SHA }, {})).toStrictEqual({});
	expect(buildSource({ GITHUB_EVENT_NAME: "pull_request_target", GITHUB_SHA: SHA }, {})).toStrictEqual({});
	expect(buildSource({ GITHUB_EVENT_NAME: "merge_group", GITHUB_SHA: SHA }, {})).toStrictEqual({});
});
