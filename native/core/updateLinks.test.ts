// Run: pnpm exec vitest run native/core/updateLinks.test.ts

import { expect, test } from "vitest";

import { comparePage, releaseOf, sourceRepo, updateLinks } from "./updateLinks";

const A = "a".repeat(40);
const B = "b".repeat(40);
const RELEASE = "https://github.com/Inrixia/luna-plugins/releases/download/latest/@inrixia.VolumeScroll";
const LATEST = { tag: "latest", page: "https://github.com/Inrixia/luna-plugins/releases/tag/latest" };

test("finds the repository a plugin is built from", () => {
	expect(sourceRepo({ repository: { url: "git+https://git.cafe/me/plugins.git" } }, "https://x.example/P")).toBe("https://git.cafe/me/plugins");
	expect(sourceRepo({ repository: "https://git.cafe/me/plugins" }, "https://x.example/P")).toBe("https://git.cafe/me/plugins");
	expect(sourceRepo({ repository: "github:o/r" }, "https://x.example/P")).toBe("https://github.com/o/r");
	expect(sourceRepo({ repository: "o/r" }, "https://x.example/P")).toBe("https://github.com/o/r");
	// The release the code downloads from wins over what the package claims
	expect(sourceRepo({ repository: { url: "https://github.com/x/benign" } }, RELEASE)).toBe("https://github.com/Inrixia/luna-plugins");
	expect(sourceRepo({ repository: { url: "javascript:alert(1)//a/b" } }, "https://x.example/P")).toBe(undefined);
	expect(sourceRepo({}, "https://x.example/P")).toBe(undefined);
});

test("finds the release a plugin url downloads from", () => {
	expect(releaseOf(RELEASE)).toStrictEqual(LATEST);
	expect(releaseOf("https://git.cafe/me/p/releases/download/v1.2/P")).toStrictEqual({
		tag: "v1.2",
		page: "https://git.cafe/me/p/releases/tag/v1.2",
	});
	expect(releaseOf("https://github.com/o/r/releases/download/plugin/v1.2/P")).toStrictEqual({
		tag: "plugin/v1.2",
		page: "https://github.com/o/r/releases/tag/plugin%2Fv1.2",
	});
	expect(releaseOf("https://github.com/o/r/releases/download/%E0/P")).toBe(undefined);
	expect(releaseOf("http://127.0.0.1:3000/P")).toBe(undefined);
});

test("compares two commits only when both are known and differ", () => {
	const repo = "https://github.com/o/r";
	expect(comparePage(repo, A, B)).toBe(`${repo}/compare/${A}...${B}`);
	expect(comparePage(repo, A, A)).toBe(undefined);
	expect(comparePage(repo, A, undefined)).toBe(undefined);
	expect(comparePage(repo, "../x", B)).toBe(undefined);
	expect(comparePage(undefined, A, B)).toBe(undefined);
});

test("update links: commits when the builds name them, and the rolling release", () => {
	const repo = "https://github.com/Inrixia/luna-plugins";
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
	expect(links.compare).toBe(`https://git.cafe/me/p/compare/${A}...${B}`);
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
