import { expect, test } from "vitest";

import { GitUrl } from "@luna/lib";

import { updateLinks } from "./updateLinks";

const A = "a".repeat(40);
const B = "b".repeat(40);
const repo = "https://github.com/Inrixia/luna-plugins";
const git = GitUrl.from(repo);

test("links both commits and what changed between them", () => {
	expect(updateLinks({ commit: A }, { commit: B }, git, "latest")).toStrictEqual({
		from: `${repo}/commit/${A}`,
		to: `${repo}/commit/${B}`,
		compare: `${repo}/compare/${A}...${B}`,
		release: { tag: "latest", page: `${repo}/releases/tag/latest` },
	});
});

test("a rolling release is linked as the release, a version tag as the version", () => {
	expect(updateLinks({}, { version: "1.3.0" }, git, "latest")).toStrictEqual({
		from: undefined,
		to: undefined,
		compare: undefined,
		release: { tag: "latest", page: `${repo}/releases/tag/latest` },
	});
	expect(updateLinks({}, { version: "1.3.0" }, git, "v1.3.0")).toStrictEqual({
		from: undefined,
		to: `${repo}/releases/tag/v1.3.0`,
		compare: undefined,
		release: undefined,
	});
});

test("no links without a repository, for invalid or equal commits, or where the forge has no compare page", () => {
	const none = { from: undefined, to: undefined, compare: undefined, release: undefined };
	expect(updateLinks({ commit: A }, { commit: B })).toStrictEqual(none);
	expect(updateLinks({ commit: "not a sha" }, { commit: "../x" }, git)).toStrictEqual(none);
	expect(updateLinks({ commit: A }, { commit: A }, git).compare).toBe(undefined);
	expect(updateLinks({ commit: A }, { commit: B }, GitUrl.from("https://git.cafe/meowarex/TidaLuna-Plugins")).compare).toBe(undefined);
});
