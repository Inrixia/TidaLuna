// Run: pnpm exec tsx --test native/core/updateLinks.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { comparePage, releaseOf, sourceRepo, updateLinks } from "./updateLinks";

const A = "a".repeat(40);
const B = "b".repeat(40);
const RELEASE = "https://github.com/Inrixia/luna-plugins/releases/download/latest/@inrixia.VolumeScroll";
const LATEST = { tag: "latest", page: "https://github.com/Inrixia/luna-plugins/releases/tag/latest" };

test("finds the repository a plugin is built from", () => {
	assert.equal(sourceRepo({ repository: { url: "git+https://git.cafe/me/plugins.git" } }, "https://x.example/P"), "https://git.cafe/me/plugins");
	assert.equal(sourceRepo({ repository: "https://git.cafe/me/plugins" }, "https://x.example/P"), "https://git.cafe/me/plugins");
	assert.equal(sourceRepo({ repository: "github:o/r" }, "https://x.example/P"), "https://github.com/o/r");
	assert.equal(sourceRepo({ repository: "o/r" }, "https://x.example/P"), "https://github.com/o/r");
	// The release the code downloads from wins over what the package claims
	assert.equal(sourceRepo({ repository: { url: "https://github.com/x/benign" } }, RELEASE), "https://github.com/Inrixia/luna-plugins");
	assert.equal(sourceRepo({ repository: { url: "javascript:alert(1)//a/b" } }, "https://x.example/P"), undefined);
	assert.equal(sourceRepo({}, "https://x.example/P"), undefined);
});

test("finds the release a plugin url downloads from", () => {
	assert.deepEqual(releaseOf(RELEASE), LATEST);
	assert.deepEqual(releaseOf("https://git.cafe/me/p/releases/download/v1.2/P"), { tag: "v1.2", page: "https://git.cafe/me/p/releases/tag/v1.2" });
	assert.deepEqual(releaseOf("https://github.com/o/r/releases/download/plugin/v1.2/P"), {
		tag: "plugin/v1.2",
		page: "https://github.com/o/r/releases/tag/plugin%2Fv1.2",
	});
	assert.equal(releaseOf("https://github.com/o/r/releases/download/%E0/P"), undefined);
	assert.equal(releaseOf("http://127.0.0.1:3000/P"), undefined);
});

test("compares two commits only when both are known and differ", () => {
	const repo = "https://github.com/o/r";
	assert.equal(comparePage(repo, A, B), `${repo}/compare/${A}...${B}`);
	assert.equal(comparePage(repo, A, A), undefined);
	assert.equal(comparePage(repo, A, undefined), undefined);
	assert.equal(comparePage(repo, "../x", B), undefined);
	assert.equal(comparePage(undefined, A, B), undefined);
});

test("update links: commits when the builds name them, and the rolling release", () => {
	const repo = "https://github.com/Inrixia/luna-plugins";
	assert.deepEqual(updateLinks(RELEASE, { commit: A }, { commit: B, repository: { url: "https://github.com/x/benign" } }), {
		from: `${repo}/commit/${A}`,
		to: `${repo}/commit/${B}`,
		compare: `${repo}/compare/${A}...${B}`,
		release: LATEST,
	});
});

test("update links: the installed version's repository wins over the update's", () => {
	const current = { repository: { url: "https://git.cafe/me/p" }, commit: A };
	const links = updateLinks("https://x.example/P", current, { repository: { url: "https://evil.example/x/y" }, commit: B });
	assert.equal(links.compare, `https://git.cafe/me/p/compare/${A}...${B}`);
});

test("update links: a rolling release is linked as the release, a version tag as the version", () => {
	assert.deepEqual(updateLinks(RELEASE, {}, { version: "1.3.0" }), { from: undefined, to: undefined, compare: undefined, release: LATEST });
	const tagged = "https://github.com/o/r/releases/download/v1.3.0/P";
	assert.deepEqual(updateLinks(tagged, {}, { version: "1.3.0" }), {
		from: undefined,
		to: "https://github.com/o/r/releases/tag/v1.3.0",
		compare: undefined,
		release: undefined,
	});
	assert.deepEqual(updateLinks("https://x.example/P", {}, {}), { from: undefined, to: undefined, compare: undefined, release: undefined });
});
