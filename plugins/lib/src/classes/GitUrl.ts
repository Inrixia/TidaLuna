import { memoize } from "@inrixia/helpers";

/**
 * Which link scheme a git host uses.
 * - github: github.com, *.githubusercontent.com
 * - gitlab: gitlab.com, or any host whose path uses GitLab's `/-/` separator (subgroups: owner may be `group/sub`)
 * - gitea: Gitea, Forgejo, Codeberg, and any unknown host (`/commit/`, `/compare/a...b`, `/releases/tag/` and `/releases/download/` match GitHub)
 * - gitcafe: git.cafe (its own forge: no web compare page, raw files and release assets served through its API)
 */
export type GitForge = "github" | "gitlab" | "gitea" | "gitcafe";

/** What a parsed url points at */
export type GitUrlKind = "repo" | "blob" | "tree" | "raw" | "release" | "commit";

type ForgeTemplate = {
	prefix: string;
	commit: string;
	commits: string;
	compare?: string;
	release: string;
	blob: (ref: string) => string;
	raw: (git: GitUrl, ref: string, path: string) => string;
};

const isFullSha = (ref: string): boolean => /^[0-9a-f]{40}$/i.test(ref);
const stripGit = (repo: string): string => repo.replace(/\.git$/, "");
const trimSlashes = (path: string): string => path.replace(/^\/+/, "");
const encodePath = (path: string): string => trimSlashes(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");

const tryDecode = (text: string): string | undefined => {
	try {
		return decodeURIComponent(text);
	} catch {
		return undefined;
	}
};

const parseRefAndPath = (segments: string[], rawRefsPrefix = false): { ref: string; path?: string } | undefined => {
	if (segments.length === 0) return undefined;
	if (rawRefsPrefix && segments[0] === "refs" && (segments[1] === "heads" || segments[1] === "tags") && segments.length >= 3) {
		const ref = tryDecode(segments[2]);
		if (!ref) return undefined;
		const path = segments.length > 3 ? tryDecode(segments.slice(3).join("/")) : undefined;
		return { ref, path };
	}
	const ref = tryDecode(segments[0]);
	if (!ref) return undefined;
	const path = segments.length > 1 ? tryDecode(segments.slice(1).join("/")) : undefined;
	return { ref, path };
};

const FORGE_TEMPLATES: Record<GitForge, ForgeTemplate> = {
	github: {
		prefix: "",
		commit: "commit",
		commits: "commits",
		compare: "compare",
		release: "releases/tag",
		blob: () => "blob",
		raw: (git, ref, path) => `https://raw.githubusercontent.com/${git.owner}/${git.repo}/${encodePath(ref)}/${encodePath(path)}`,
	},
	gitlab: {
		prefix: "/-",
		commit: "commit",
		commits: "commits",
		compare: "compare",
		release: "releases",
		blob: () => "blob",
		raw: (git, ref, path) => `${git.repoUrl}/-/raw/${encodePath(ref)}/${encodePath(path)}`,
	},
	gitea: {
		prefix: "",
		commit: "commit",
		commits: "commits/branch",
		compare: "compare",
		release: "releases/tag",
		blob: (ref) => `src/${isFullSha(ref) ? "commit" : "branch"}`,
		raw: (git, ref, path) => `${git.repoUrl}/raw/${isFullSha(ref) ? "commit" : "branch"}/${encodePath(ref)}/${encodePath(path)}`,
	},
	gitcafe: {
		prefix: "",
		commit: "commit",
		commits: "commits",
		release: "releases/tag",
		blob: () => "blob",
		raw: (git, ref, path) => `${git.origin}/api/repos/${git.owner}/${git.repo}/raw?${new URLSearchParams({ ref, path })}`,
	},
};

/**
 * A url of a git repository or of something in one (file page, raw file, release asset, commit), parsed once.
 * Get instances through GitUrl.from (memoized per url) or GitUrl.fromRepository, never the constructor.
 */
export class GitUrl {
	/** Parse a url, undefined if it is not an http(s) url of a git repository. Memoized: the same url string returns the same instance */
	public static readonly from: (url: string) => GitUrl | undefined = memoize((url: string): GitUrl | undefined => {
		if (typeof url !== "string") return undefined;
		let parsed: URL;
		try {
			parsed = new URL(url.trim());
		} catch {
			return undefined;
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
		const segments = parsed.pathname.split("/").filter(Boolean);
		if (segments.length < 2) return undefined;

		const host = parsed.hostname.toLowerCase();
		const isGhRaw = host.endsWith(".githubusercontent.com");
		const isGiteaSrc = segments[2] === "src" && /^(branch|tag|commit)$/.test(segments[3] ?? "");
		const forge: GitForge =
			host === "github.com" || isGhRaw
				? "github"
				: host === "git.cafe"
					? "gitcafe"
					: host === "codeberg.org" || isGiteaSrc
						? "gitea"
						: host === "gitlab.com" || segments.includes("-")
							? "gitlab"
							: "gitea";

		const origin = isGhRaw ? "https://github.com" : parsed.origin;
		return GitUrl.parseForge(forge, origin, segments, parsed.searchParams, isGhRaw);
	});

	/** A package.json `repository`: a string or `{ url }`, as a url, `git+https://host/owner/repo.git`, `owner/repo` or `github:owner/repo` */
	public static fromRepository(repository: unknown): GitUrl | undefined {
		const raw =
			typeof repository === "string"
				? repository
				: repository !== null && typeof repository === "object"
					? (repository as { url?: unknown }).url
					: undefined;
		if (typeof raw !== "string") return undefined;
		const text = raw.trim();
		const shorthand = text.match(/^(?:github:)?([\w.-]+)\/([\w.-]+)$/);
		if (shorthand !== null) return GitUrl.from(`https://github.com/${shorthand[1]}/${shorthand[2]}`);
		return GitUrl.from(text.replace(/^git\+/, ""));
	}

	private static parseForge(
		forge: GitForge,
		origin: string,
		segments: string[],
		searchParams: URLSearchParams,
		isGhRaw: boolean,
	): GitUrl | undefined {
		if (forge === "gitlab") return GitUrl.parseGitLab(origin, segments);
		if (forge === "gitcafe" && segments[0] === "api" && segments[1] === "repos") {
			if (segments.length < 4) return undefined;
			const owner = segments[2];
			const repo = stripGit(segments[3]);
			if (!owner || !repo) return undefined;
			const rest = segments.slice(4);
			if (rest[0] === "raw") {
				const ref = searchParams.get("ref") ?? undefined;
				const rawPath = searchParams.get("path");
				const path = rawPath !== null ? trimSlashes(rawPath) || undefined : undefined;
				return new GitUrl(forge, origin, owner, repo, "raw", ref, path);
			}
			if (rest[0] === "releases" && rest.includes("download")) {
				return new GitUrl(forge, origin, owner, repo, "release");
			}
			return new GitUrl(forge, origin, owner, repo, "repo");
		}

		const owner = segments[0];
		const repo = stripGit(segments[1]);
		if (!owner || !repo) return undefined;
		const rest = segments.slice(2);

		if (isGhRaw) {
			if (rest.length === 0) return new GitUrl(forge, origin, owner, repo, "repo");
			const refPath = parseRefAndPath(rest, true);
			if (refPath?.path === undefined) return undefined;
			return new GitUrl(forge, origin, owner, repo, "raw", refPath.ref, refPath.path);
		}

		if (forge === "gitea") {
			if ((rest[0] === "src" || rest[0] === "raw") && /^(branch|tag|commit)$/.test(rest[1] ?? "")) {
				const refPath = parseRefAndPath(rest.slice(2));
				if (refPath?.path !== undefined) {
					return new GitUrl(forge, origin, owner, repo, rest[0] === "raw" ? "raw" : "blob", refPath.ref, refPath.path);
				}
			}
			return GitUrl.parseSharedRoutes(forge, origin, owner, repo, rest);
		}

		if (rest[0] === "blob" || rest[0] === "tree" || (forge === "github" && rest[0] === "raw")) {
			const refPath = parseRefAndPath(rest.slice(1), rest[0] === "raw");
			if (refPath !== undefined && (rest[0] === "tree" || refPath.path !== undefined)) {
				return new GitUrl(forge, origin, owner, repo, rest[0], refPath.ref, refPath.path);
			}
		}

		return GitUrl.parseSharedRoutes(forge, origin, owner, repo, rest);
	}

	private static parseGitLab(origin: string, segments: string[]): GitUrl | undefined {
		const dashIdx = segments.indexOf("-");
		if (dashIdx === -1) {
			const owner = segments.slice(0, -1).join("/");
			const repo = stripGit(segments[segments.length - 1]);
			return owner && repo ? new GitUrl("gitlab", origin, owner, repo, "repo") : undefined;
		}
		if (dashIdx < 2) return undefined;
		const owner = segments.slice(0, dashIdx - 1).join("/");
		const repo = stripGit(segments[dashIdx - 1]);
		if (!owner || !repo) return undefined;
		const rest = segments.slice(dashIdx + 1);
		if (rest[0] === "blob" || rest[0] === "tree" || rest[0] === "raw") {
			const refPath = parseRefAndPath(rest.slice(1));
			if (refPath !== undefined && (rest[0] === "tree" || refPath.path !== undefined)) {
				return new GitUrl("gitlab", origin, owner, repo, rest[0], refPath.ref, refPath.path);
			}
		}
		if (rest[0] === "commit" && rest[1]) return new GitUrl("gitlab", origin, owner, repo, "commit", undefined, undefined, undefined, rest[1]);
		if (rest[0] === "releases" && rest.length >= 2) {
			const dlIdx = rest.lastIndexOf("downloads");
			if (dlIdx >= 2 && dlIdx < rest.length - 1) {
				const tag = tryDecode(rest.slice(1, dlIdx).join("/"));
				const asset = tryDecode(rest[rest.length - 1]);
				return new GitUrl("gitlab", origin, owner, repo, "release", undefined, undefined, tag, undefined, asset);
			}
			return new GitUrl("gitlab", origin, owner, repo, "release", undefined, undefined, tryDecode(rest.slice(1).join("/")));
		}
		return new GitUrl("gitlab", origin, owner, repo, "repo");
	}

	private static parseSharedRoutes(forge: GitForge, origin: string, owner: string, repo: string, rest: string[]): GitUrl {
		if (rest[0] === "commit" && rest[1]) return new GitUrl(forge, origin, owner, repo, "commit", undefined, undefined, undefined, rest[1]);
		if (rest[0] === "releases") {
			if (rest[1] === "tag" && rest.length >= 3) {
				return new GitUrl(forge, origin, owner, repo, "release", undefined, undefined, tryDecode(rest.slice(2).join("/")));
			}
			if (rest[1] === "download" && rest.length >= 4) {
				const tag = tryDecode(rest.slice(2, -1).join("/"));
				const asset = tryDecode(rest[rest.length - 1]);
				return new GitUrl(forge, origin, owner, repo, "release", undefined, undefined, tag, undefined, asset);
			}
		}
		return new GitUrl(forge, origin, owner, repo, "repo");
	}

	private constructor(
		public readonly forge: GitForge,
		/** `https://host` */
		public readonly origin: string,
		public readonly owner: string,
		public readonly repo: string,
		public readonly kind: GitUrlKind,
		/** Branch, tag or commit of a blob/tree/raw url */
		public readonly ref?: string,
		/** File or folder path inside the repository, without leading `/`, decoded */
		public readonly path?: string,
		/** Release tag of a release page or release asset url, decoded */
		public readonly tag?: string,
		/** Commit of a commit url */
		public readonly sha?: string,
		private readonly asset?: string,
	) {}

	public get host(): string {
		return new URL(this.origin).host;
	}
	/** Last path segment, decoded (file name of a blob/raw url or release asset), if any */
	public get fileName(): string | undefined {
		if (this.path !== undefined) return this.path.split("/").filter(Boolean).pop();
		return this.asset;
	}

	/** Web page of the repository: `https://host/owner/repo` (`.git` dropped) */
	public get repoUrl(): string {
		return `${this.origin}/${this.owner}/${this.repo}`;
	}
	/** Readable page of the file (blob page), for a blob or raw url */
	public get browseUrl(): string | undefined {
		if ((this.kind !== "blob" && this.kind !== "raw") || this.ref === undefined || this.path === undefined) return undefined;
		return this.blobUrl(this.ref, this.path);
	}
	/** Fetchable file, for a blob or raw url */
	public get rawUrl(): string | undefined {
		if ((this.kind !== "blob" && this.kind !== "raw") || this.ref === undefined || this.path === undefined) return undefined;
		return this.rawFileUrl(this.ref, this.path);
	}

	public commitUrl(sha: string): string | undefined {
		if (!sha) return undefined;
		const tpl = FORGE_TEMPLATES[this.forge];
		return `${this.repoUrl}${tpl.prefix}/${tpl.commit}/${encodeURIComponent(sha)}`;
	}
	public commitsUrl(ref: string): string | undefined {
		const encoded = encodePath(ref);
		if (!encoded) return undefined;
		const tpl = FORGE_TEMPLATES[this.forge];
		return `${this.repoUrl}${tpl.prefix}/${tpl.commits}/${encoded}`;
	}
	/** What changed between two commits, undefined where the forge has no compare page (gitcafe) */
	public compareUrl(from: string, to: string): string | undefined {
		const tpl = FORGE_TEMPLATES[this.forge];
		if (tpl.compare === undefined) return undefined;
		const encFrom = encodePath(from);
		const encTo = encodePath(to);
		if (!encFrom || !encTo) return undefined;
		return `${this.repoUrl}${tpl.prefix}/${tpl.compare}/${encFrom}...${encTo}`;
	}
	public releaseUrl(tag: string): string | undefined {
		if (!tag) return undefined;
		const tpl = FORGE_TEMPLATES[this.forge];
		return `${this.repoUrl}${tpl.prefix}/${tpl.release}/${encodeURIComponent(tag)}`;
	}
	public blobUrl(ref: string, path: string): string | undefined {
		const encRef = encodePath(ref);
		const encPath = encodePath(path);
		if (!encRef || !encPath) return undefined;
		const tpl = FORGE_TEMPLATES[this.forge];
		return `${this.repoUrl}${tpl.prefix}/${tpl.blob(ref)}/${encRef}/${encPath}`;
	}
	public rawFileUrl(ref: string, path: string): string | undefined {
		const cleanPath = trimSlashes(path);
		if (!ref || !cleanPath) return undefined;
		return FORGE_TEMPLATES[this.forge].raw(this, ref, cleanPath);
	}
}
