// Run: pnpm exec vitest run native/core/updateLinks.test.ts

import { expect, test } from "vitest";

import { updateLinks } from "./updateLinks";

const A = "a".repeat(40);
const B = "b".repeat(40);
const RELEASE = "https://github.com/Inrixia/luna-plugins/releases/download/latest/@inrixia.VolumeScroll";
const REPO = "https://github.com/Inrixia/luna-plugins";
const LATEST = { tag: "latest", page: `${REPO}/releases/tag/latest` };

test("update links: commits when the builds name them, and the rolling release", () => {
	expect(updateLinks(RELEASE, { commit: A }, { commit: B, repository: { url: "https://github.com/x/benign" } })).toStrictEqual({
		from: `${REPO}/commit/${A}`,
		to: `${REPO}/commit/${B}`,
		compare: `${REPO}/compare/${A}...${B}`,
		release: LATEST,
	});
});

test("update links: the repository the release downloads from wins over what the package claims", () => {
	const links = updateLinks(RELEASE, { repository: { url: "https://github.com/x/benign" }, commit: A }, { commit: B });
	expect(links.compare).toBe(`${REPO}/compare/${A}...${B}`);
});

test("update links: the installed version's repository wins over the update's", () => {
	const current = { repository: { url: "git+https://git.cafe/me/p.git" }, commit: A };
	const links = updateLinks("https://x.example/P", current, { repository: { url: "https://evil.example/x/y" }, commit: B });
	// git.cafe has no compare page, the commit pages are the installed version's repository
	expect(links.from).toBe(`https://git.cafe/me/p/commit/${A}`);
	expect(links.to).toBe(`https://git.cafe/me/p/commit/${B}`);
	expect(links.compare).toBe(undefined);
});

test("update links: shorthand repositories and non-string commits", () => {
	expect(updateLinks("https://x.example/P", { repository: "o/r", commit: A }, { commit: B }).compare).toBe(
		`https://github.com/o/r/compare/${A}...${B}`,
	);
	expect(updateLinks("https://x.example/P", { repository: "o/r", commit: 5 }, { commit: "../x" }).compare).toBe(undefined);
	expect(updateLinks("https://x.example/P", { repository: { url: "javascript:alert(1)//a/b" } }, {})).toStrictEqual({
		from: undefined,
		to: undefined,
		compare: undefined,
		release: undefined,
	});
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
	expect(updateLinks("http://127.0.0.1:3000/P", {}, {})).toStrictEqual({
		from: undefined,
		to: undefined,
		compare: undefined,
		release: undefined,
	});
});
