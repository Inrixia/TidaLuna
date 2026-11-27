import { describe, expect, test } from "vitest";

import { GitUrl } from "./GitUrl";

const SHA = "72b4b48cbae70fdac11e938fab43e72b37fb8bb5";
const SHA_B = "b".repeat(40);

describe("GitUrl.from validation and memoization", () => {
	test.each(["file:///tmp/repo", "javascript:alert(1)//a/b", "not a url", "https://github.com/", "https://github.com/owner", ""])(
		"rejects %j",
		(input) => {
			expect(GitUrl.from(input)).toBeUndefined();
		},
	);

	test("memoizes by input string and trims whitespace", () => {
		const url = "https://github.com/Inrixia/luna-plugins";
		expect(GitUrl.from(url)).toBe(GitUrl.from(url));
		expect(GitUrl.from(`  ${url}  `)?.repoUrl).toBe(url);
		expect(GitUrl.from("https://github.com/o/r.git")?.repoUrl).toBe("https://github.com/o/r");
		expect(GitUrl.from("https://github.com/o/.git")).toBeUndefined();
	});
});

describe("GitUrl constructor", () => {
	test("builds links from known parts", () => {
		const git = new GitUrl({
			forge: "gitlab",
			origin: "https://gitlab.com",
			owner: "group/sub",
			repo: "r",
			kind: "blob",
			ref: "main",
			path: "a b/c.css",
		});
		expect(git.repoUrl).toBe("https://gitlab.com/group/sub/r");
		expect(git.fileName).toBe("c.css");
		expect(git.browseUrl).toBe("https://gitlab.com/group/sub/r/-/blob/main/a%20b/c.css");
		expect(git.rawUrl).toBe("https://gitlab.com/group/sub/r/-/raw/main/a%20b/c.css");
	});
});

describe("GitUrl.fromRepository", () => {
	test("parses string, object, git+, shorthands and rejects invalid inputs", () => {
		expect(GitUrl.fromRepository({ url: "git+https://git.cafe/me/plugins.git" })?.repoUrl).toBe("https://git.cafe/me/plugins");
		expect(GitUrl.fromRepository("https://git.cafe/me/plugins")?.repoUrl).toBe("https://git.cafe/me/plugins");
		expect(GitUrl.fromRepository("github:o/r")?.repoUrl).toBe("https://github.com/o/r");
		expect(GitUrl.fromRepository("o/r")?.repoUrl).toBe("https://github.com/o/r");
		expect(GitUrl.fromRepository("  github:o/r.git  ")?.repoUrl).toBe("https://github.com/o/r");
		expect(GitUrl.fromRepository({ url: "javascript:alert(1)//a/b" })).toBeUndefined();
		expect(GitUrl.fromRepository({})).toBeUndefined();
		expect(GitUrl.fromRepository(null)).toBeUndefined();
	});
});

describe("GitHub", () => {
	test("parses repo, blob, tree, raw, commit and release urls", () => {
		const repo = GitUrl.from("https://github.com/o/r.git")!;
		expect(repo).toMatchObject({ forge: "github", origin: "https://github.com", host: "github.com", owner: "o", repo: "r", kind: "repo" });
		expect(repo.fileName).toBeUndefined();
		expect(repo.browseUrl).toBeUndefined();
		expect(repo.rawUrl).toBeUndefined();

		const blob = GitUrl.from("https://github.com/aya-zzz-zzz/cottoncandynights/blob/main/fonts/techroundpack.css")!;
		expect(blob).toMatchObject({
			forge: "github",
			owner: "aya-zzz-zzz",
			repo: "cottoncandynights",
			kind: "blob",
			ref: "main",
			path: "fonts/techroundpack.css",
			fileName: "techroundpack.css",
		});
		expect(blob.rawUrl).toBe("https://raw.githubusercontent.com/aya-zzz-zzz/cottoncandynights/main/fonts/techroundpack.css");
		expect(blob.browseUrl).toBe("https://github.com/aya-zzz-zzz/cottoncandynights/blob/main/fonts/techroundpack.css");

		const tree = GitUrl.from("https://github.com/o/r/tree/main/src/lib")!;
		expect(tree).toMatchObject({ forge: "github", kind: "tree", ref: "main", path: "src/lib", fileName: "lib" });
		expect(tree.browseUrl).toBeUndefined();
		expect(tree.rawUrl).toBeUndefined();

		const ghRaw = GitUrl.from("https://github.com/o/r/raw/main/a/b.txt")!;
		expect(ghRaw).toMatchObject({ kind: "raw", ref: "main", path: "a/b.txt" });
		expect(ghRaw.browseUrl).toBe("https://github.com/o/r/blob/main/a/b.txt");
		expect(ghRaw.rawUrl).toBe("https://raw.githubusercontent.com/o/r/main/a/b.txt");

		const ghRawRefs = GitUrl.from("https://github.com/o/r/raw/refs/heads/main/a/b.txt")!;
		expect(ghRawRefs).toMatchObject({ kind: "raw", ref: "main", path: "a/b.txt" });

		const commit = GitUrl.from(`https://github.com/o/r/commit/${SHA}`)!;
		expect(commit).toMatchObject({ forge: "github", kind: "commit", sha: SHA, fileName: undefined });

		const releaseTag = GitUrl.from("https://github.com/o/r/releases/tag/plugin%2Fv1.2")!;
		expect(releaseTag).toMatchObject({ forge: "github", kind: "release", tag: "plugin/v1.2", fileName: undefined });

		const releaseDl = GitUrl.from("https://github.com/meowarex/TidalLuna-Plugins/releases/download/latest/store.json")!;
		expect(releaseDl).toMatchObject({
			forge: "github",
			owner: "meowarex",
			repo: "TidalLuna-Plugins",
			kind: "release",
			tag: "latest",
			fileName: "store.json",
		});

		const slashTag = GitUrl.from("https://github.com/o/r/releases/download/plugin/v1.2/P")!;
		expect(slashTag).toMatchObject({ kind: "release", tag: "plugin/v1.2", fileName: "P" });
		expect(slashTag.releaseUrl(slashTag.tag!)).toBe("https://github.com/o/r/releases/tag/plugin%2Fv1.2");

		const malformed = GitUrl.from("https://github.com/o/r/releases/download/%E0/P")!;
		expect(malformed).toMatchObject({ forge: "github", kind: "release", tag: undefined, fileName: "P" });
	});

	test("parses raw.githubusercontent.com with refs/heads, refs/tags, and short refs, and round-trips encoded paths", () => {
		const rawHeads = GitUrl.from("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/refs/heads/main/base-windows.css")!;
		expect(rawHeads).toMatchObject({
			forge: "github",
			origin: "https://github.com",
			host: "github.com",
			owner: "aya-zzz-zzz",
			repo: "cotton-candy-colorways",
			kind: "raw",
			ref: "main",
			path: "base-windows.css",
			fileName: "base-windows.css",
		});
		expect(rawHeads.browseUrl).toBe("https://github.com/aya-zzz-zzz/cotton-candy-colorways/blob/main/base-windows.css");
		expect(rawHeads.rawUrl).toBe("https://raw.githubusercontent.com/aya-zzz-zzz/cotton-candy-colorways/main/base-windows.css");

		const rawTags = GitUrl.from("https://raw.githubusercontent.com/o/r/refs/tags/v1.0/pride%20collection/x.css")!;
		expect(rawTags).toMatchObject({ kind: "raw", ref: "v1.0", path: "pride collection/x.css", fileName: "x.css" });
		expect(rawTags.browseUrl).toBe("https://github.com/o/r/blob/v1.0/pride%20collection/x.css");
		expect(rawTags.rawUrl).toBe("https://raw.githubusercontent.com/o/r/v1.0/pride%20collection/x.css");

		const shortRef = GitUrl.from("https://raw.githubusercontent.com/o/r/dev/sub/file.ts")!;
		expect(shortRef).toMatchObject({ kind: "raw", ref: "dev", path: "sub/file.ts" });
	});

	test("builds github urls", () => {
		const g = GitUrl.from("https://github.com/o/r")!;
		expect(g.commitUrl(SHA)).toBe(`https://github.com/o/r/commit/${SHA}`);
		expect(g.commitsUrl("main")).toBe("https://github.com/o/r/commits/main");
		expect(g.compareUrl(SHA, SHA_B)).toBe(`https://github.com/o/r/compare/${SHA}...${SHA_B}`);
		expect(g.releaseUrl("plugin/v1.2")).toBe("https://github.com/o/r/releases/tag/plugin%2Fv1.2");
		expect(g.blobUrl("main", "pride collection/x.css")).toBe("https://github.com/o/r/blob/main/pride%20collection/x.css");
		expect(g.rawFileUrl("main", "pride collection/x.css")).toBe("https://raw.githubusercontent.com/o/r/main/pride%20collection/x.css");
	});
});

describe("GitLab", () => {
	test("parses gitlab.com subgroups and self-hosted /-/ urls", () => {
		const subgroup = GitUrl.from("https://gitlab.com/group/sub/repo.git")!;
		expect(subgroup).toMatchObject({ forge: "gitlab", owner: "group/sub", repo: "repo", kind: "repo" });
		expect(subgroup.repoUrl).toBe("https://gitlab.com/group/sub/repo");

		const blob = GitUrl.from("https://git.internal.example/group/sub/repo/-/blob/main/pride%20collection/x.css")!;
		expect(blob).toMatchObject({
			forge: "gitlab",
			origin: "https://git.internal.example",
			owner: "group/sub",
			repo: "repo",
			kind: "blob",
			ref: "main",
			path: "pride collection/x.css",
			fileName: "x.css",
		});
		expect(blob.browseUrl).toBe("https://git.internal.example/group/sub/repo/-/blob/main/pride%20collection/x.css");
		expect(blob.rawUrl).toBe("https://git.internal.example/group/sub/repo/-/raw/main/pride%20collection/x.css");

		expect(GitUrl.from("https://gitlab.com/o/r/-/tree/main/dir")).toMatchObject({ kind: "tree", ref: "main", path: "dir" });
		expect(GitUrl.from("https://gitlab.com/o/r/-/raw/main/a.ts")).toMatchObject({ kind: "raw", ref: "main", path: "a.ts" });
		expect(GitUrl.from(`https://gitlab.com/o/r/-/commit/${SHA}`)).toMatchObject({ kind: "commit", sha: SHA });
		expect(GitUrl.from("https://gitlab.com/o/r/-/releases/v1.0")).toMatchObject({ kind: "release", tag: "v1.0", fileName: undefined });
		expect(GitUrl.from("https://gitlab.com/o/r/-/releases/v1.0/downloads/app.zip")).toMatchObject({
			kind: "release",
			tag: "v1.0",
			fileName: "app.zip",
		});
		expect(GitUrl.from("https://gitlab.com/o/-/blob/main/a.ts")).toBeUndefined();
	});

	test("builds gitlab urls", () => {
		const g = GitUrl.from("https://gitlab.com/group/sub/repo")!;
		expect(g.commitUrl(SHA)).toBe(`https://gitlab.com/group/sub/repo/-/commit/${SHA}`);
		expect(g.commitsUrl("main")).toBe("https://gitlab.com/group/sub/repo/-/commits/main");
		expect(g.compareUrl(SHA, SHA_B)).toBe(`https://gitlab.com/group/sub/repo/-/compare/${SHA}...${SHA_B}`);
		expect(g.releaseUrl("v1.0/a")).toBe("https://gitlab.com/group/sub/repo/-/releases/v1.0%2Fa");
		expect(g.blobUrl("main", "a/b.ts")).toBe("https://gitlab.com/group/sub/repo/-/blob/main/a/b.ts");
		expect(g.rawFileUrl("main", "a/b.ts")).toBe("https://gitlab.com/group/sub/repo/-/raw/main/a/b.ts");
	});
});

describe("Gitea / Codeberg / default host", () => {
	test("parses codeberg, /src/branch|tag|commit/, raw, commit, and release urls", () => {
		const blob = GitUrl.from("https://codeberg.org/o/r/src/branch/main/a/b.css")!;
		expect(blob).toMatchObject({ forge: "gitea", owner: "o", repo: "r", kind: "blob", ref: "main", path: "a/b.css", fileName: "b.css" });
		expect(blob.rawUrl).toBe("https://codeberg.org/o/r/raw/branch/main/a/b.css");
		expect(blob.browseUrl).toBe("https://codeberg.org/o/r/src/branch/main/a/b.css");

		expect(GitUrl.from("https://forge.example/o/r/src/tag/v1.0/f.ts")).toMatchObject({
			forge: "gitea",
			kind: "blob",
			ref: "v1.0",
			path: "f.ts",
		});
		expect(GitUrl.from(`https://forge.example/o/r/src/commit/${SHA}/f.ts`)).toMatchObject({
			forge: "gitea",
			kind: "blob",
			ref: SHA,
			path: "f.ts",
		});
		const rawSha = GitUrl.from(`https://codeberg.org/o/r/raw/commit/${SHA}/f.ts`)!;
		expect(rawSha).toMatchObject({ forge: "gitea", kind: "raw", ref: SHA, path: "f.ts" });
		expect(rawSha.browseUrl).toBe(`https://codeberg.org/o/r/src/commit/${SHA}/f.ts`);
		expect(rawSha.rawUrl).toBe(`https://codeberg.org/o/r/raw/commit/${SHA}/f.ts`);

		expect(GitUrl.from("https://codeberg.org/o/r/raw/tag/v1.0/f.ts")).toMatchObject({ kind: "raw", ref: "v1.0", path: "f.ts" });
		expect(GitUrl.from(`https://codeberg.org/o/r/commit/${SHA}`)).toMatchObject({ kind: "commit", sha: SHA });
		expect(GitUrl.from("https://codeberg.org/o/r/releases/tag/v1.0")).toMatchObject({ kind: "release", tag: "v1.0" });
		expect(GitUrl.from("https://codeberg.org/o/r/releases/download/v1.0/P")).toMatchObject({
			kind: "release",
			tag: "v1.0",
			fileName: "P",
		});
	});

	test("builds gitea urls with branch vs 40-hex sha", () => {
		const g = GitUrl.from("https://codeberg.org/o/r")!;
		expect(g.commitUrl(SHA)).toBe(`https://codeberg.org/o/r/commit/${SHA}`);
		expect(g.commitsUrl("main")).toBe("https://codeberg.org/o/r/commits/branch/main");
		expect(g.compareUrl(SHA, SHA_B)).toBe(`https://codeberg.org/o/r/compare/${SHA}...${SHA_B}`);
		expect(g.releaseUrl("v1.0")).toBe("https://codeberg.org/o/r/releases/tag/v1.0");
		expect(g.blobUrl("main", "a/b.ts")).toBe("https://codeberg.org/o/r/src/branch/main/a/b.ts");
		expect(g.blobUrl(SHA, "a/b.ts")).toBe(`https://codeberg.org/o/r/src/commit/${SHA}/a/b.ts`);
		expect(g.rawFileUrl("main", "a/b.ts")).toBe("https://codeberg.org/o/r/raw/branch/main/a/b.ts");
		expect(g.rawFileUrl(SHA, "a/b.ts")).toBe(`https://codeberg.org/o/r/raw/commit/${SHA}/a/b.ts`);
	});
});

describe("GitCafe", () => {
	test("parses blob, tree, commit, release, and api raw/asset urls", () => {
		const blob = GitUrl.from("https://git.cafe/meowarex/TidaLuna-Plugins/blob/HEAD/package.json")!;
		expect(blob).toMatchObject({
			forge: "gitcafe",
			origin: "https://git.cafe",
			owner: "meowarex",
			repo: "TidaLuna-Plugins",
			kind: "blob",
			ref: "HEAD",
			path: "package.json",
			fileName: "package.json",
		});
		expect(blob.rawUrl).toBe("https://git.cafe/api/repos/meowarex/TidaLuna-Plugins/raw?ref=HEAD&path=package.json");
		expect(blob.browseUrl).toBe("https://git.cafe/meowarex/TidaLuna-Plugins/blob/HEAD/package.json");

		const commit = GitUrl.from(`https://git.cafe/meowarex/TidaLuna-Plugins/commit/${SHA}`)!;
		expect(commit).toMatchObject({ forge: "gitcafe", kind: "commit", sha: SHA });

		const tree = GitUrl.from("https://git.cafe/meowarex/TidaLuna-Plugins/tree/refs%2Ftags%2Flatest")!;
		expect(tree).toMatchObject({
			forge: "gitcafe",
			owner: "meowarex",
			repo: "TidaLuna-Plugins",
			kind: "tree",
			ref: "refs/tags/latest",
			path: undefined,
		});

		const apiRaw = GitUrl.from("https://git.cafe/api/repos/meowarex/TidaLuna-Plugins/raw?ref=HEAD&path=package.json")!;
		expect(apiRaw).toMatchObject({
			forge: "gitcafe",
			owner: "meowarex",
			repo: "TidaLuna-Plugins",
			kind: "raw",
			ref: "HEAD",
			path: "package.json",
			fileName: "package.json",
		});
		expect(apiRaw.browseUrl).toBe("https://git.cafe/meowarex/TidaLuna-Plugins/blob/HEAD/package.json");

		const apiAsset = GitUrl.from("https://git.cafe/api/repos/meowarex/TidaLuna-Plugins/releases/12/assets/34/download")!;
		expect(apiAsset).toMatchObject({
			forge: "gitcafe",
			owner: "meowarex",
			repo: "TidaLuna-Plugins",
			kind: "release",
		});
		expect(apiAsset.tag).toBeUndefined();
		expect(apiAsset.fileName).toBeUndefined();

		expect(GitUrl.from("https://git.cafe/meowarex/TidaLuna-Plugins/releases/tag/latest")).toMatchObject({
			forge: "gitcafe",
			kind: "release",
			tag: "latest",
		});
		expect(GitUrl.from("https://git.cafe/me/p/releases/download/v1.2/P")).toMatchObject({
			forge: "gitcafe",
			kind: "release",
			tag: "v1.2",
			fileName: "P",
		});
		expect(GitUrl.from("https://git.cafe/api/repos/onlyowner")).toBeUndefined();
	});

	test("builds gitcafe urls", () => {
		const g = GitUrl.from("https://git.cafe/meowarex/TidaLuna-Plugins")!;
		expect(g.commitUrl(SHA)).toBe(`https://git.cafe/meowarex/TidaLuna-Plugins/commit/${SHA}`);
		expect(g.commitsUrl("HEAD")).toBe("https://git.cafe/meowarex/TidaLuna-Plugins/commits/HEAD");
		expect(g.compareUrl(SHA, SHA_B)).toBeUndefined();
		expect(g.releaseUrl("latest")).toBe("https://git.cafe/meowarex/TidaLuna-Plugins/releases/tag/latest");
		expect(g.blobUrl("HEAD", "pride collection/x.css")).toBe("https://git.cafe/meowarex/TidaLuna-Plugins/blob/HEAD/pride%20collection/x.css");
		expect(g.rawFileUrl("HEAD", "pride collection/x.css")).toBe(
			"https://git.cafe/api/repos/meowarex/TidaLuna-Plugins/raw?ref=HEAD&path=pride+collection%2Fx.css",
		);
	});
});
