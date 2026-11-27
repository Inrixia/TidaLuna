// Run: pnpm exec vitest run native/core/updateLinks.test.ts

import { expect, test } from "vitest";

import { updateLinks } from "./updateLinks";

const A = "a".repeat(40);
const B = "b".repeat(40);
const RELEASE = "https://github.com/Inrixia/luna-plugins/releases/download/latest/@inrixia.VolumeScroll";
const repo = "https://github.com/Inrixia/luna-plugins";
const LATEST = { tag: "latest", page: `${repo}/releases/tag/latest` };

test("update links: commits when the builds name them, and the rolling release", () => {
	expect(updateLinks(RELEASE, { commit: A }, { commit: B, repository: { url: "https://github.com/x/benign" } })).toStrictEqual({
		from: `${repo}/commit/${A}`,
		to: `${repo}/commit/${B}`,
		compare: `${repo}/compare/${A}...${B}`,
		release: LATEST,
	});
});

test("update links: the installed version's repository wins over the update's", () => {
	const current = { repository: { url: "https://git.cafe/me/p" }, commit: A };
	const links = updateLinks("https://x.example/P", current, { repository: { url: "https://evil.example/x/y" }, commit: B });
	// git.cafe has no compare page, the commits still link
	expect(links.from).toBe(`https://git.cafe/me/p/commit/${A}`);
	expect(links.to).toBe(`https://git.cafe/me/p/commit/${B}`);
	const gitea = updateLinks("https://x.example/P", { repository: "https://codeberg.org/me/p", commit: A }, { commit: B });
	expect(gitea.compare).toBe(`https://codeberg.org/me/p/compare/${A}...${B}`);
});

test("update links: a malformed or non-http repository gives no links", () => {
	const links = updateLinks("https://x.example/P", { repository: { url: "javascript:alert(1)//a/b" }, commit: A }, { commit: B });
	expect(links).toStrictEqual({ from: undefined, to: undefined, compare: undefined, release: undefined });
});

test("update links: a rolling release is linked as the release, a version tag as the version", () => {
	expect(updateLinks(RELEASE, {}, { version: "1.3.0" })).toStrictEqual({ from: undefined, to: undefined, compare: undefined, release: LATEST });
	const tagged = "https://github.com/o/r/releases/download/v1.3.0/P";
	expect(updateLinks(tagged, {}, { version: "1.3.0" })).toStrictEqual({
		from: undefined,
		to: "https://github.com/o/r/releases/tag/v1.3.0",
		compare: undefined,
		release: undefined,
	});
	expect(updateLinks("https://x.example/P", {}, {})).toStrictEqual({ from: undefined, to: undefined, compare: undefined, release: undefined });
});
