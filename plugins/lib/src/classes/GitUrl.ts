import { memoize } from "@inrixia/helpers";

/**
 * Which link scheme a git host uses.
 * - github: github.com and raw.githubusercontent.com
 * - gitlab: gitlab.com, or any host whose path uses GitLab's `/-/` separator. Owners may be subgroups (`group/sub`)
 * - gitea: Gitea, Forgejo, Codeberg and any other host (their links match GitHub's, except files: `/src/branch/<ref>/<path>`)
 * - gitcafe: git.cafe (no compare page; raw files and release assets are served through its API)
 */
export type GitForge = "github" | "gitlab" | "gitea" | "gitcafe";

/** What a url points at */
export type GitUrlKind = "repo" | "blob" | "tree" | "raw" | "release" | "commit";

/** Everything a GitUrl holds, see the fields of GitUrl */
export type GitUrlParts = Pick<GitUrl, "forge" | "origin" | "owner" | "repo" | "kind" | "ref" | "path" | "tag" | "sha" | "asset">;

/** What the part of a url after the repository points at */
type Target = Pick<GitUrlParts, "kind" | "ref" | "path" | "tag" | "sha" | "asset">;

const RAW_GITHUB = "raw.githubusercontent.com";
const REPO: Target = { kind: "repo" };

/** Url segments joined with `/` and decoded, undefined if an escape is malformed */
const decode = (segments: string[]): string | undefined => {
	try {
		return decodeURIComponent(segments.join("/"));
	} catch {
		return undefined;
	}
};
/** Each segment of a ref or path encoded, the `/` between them kept */
const encodePath = (path: string): string => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

const httpUrl = (text: string): URL | undefined => {
	try {
		const url = new URL(text.trim());
		return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
	} catch {
		return undefined;
	}
};

const forgeOf = (host: string, segments: string[]): GitForge => {
	if (host === "github.com" || host === RAW_GITHUB) return "github";
	if (host === "git.cafe") return "gitcafe";
	// Checked before GitLab: a Gitea file path may hold a `-` segment
	if (host === "codeberg.org" || (/^(src|raw)$/.test(segments[2]) && /^(branch|tag|commit)$/.test(segments[3]))) return "gitea";
	if (host === "gitlab.com" || segments.includes("-")) return "gitlab";
	return "gitea";
};

/** Where the repository is in the path, and the route after it */
const locateRepo = (forge: GitForge, host: string, segments: string[]): { owner?: string; repo?: string; route: string[] } => {
	if (forge === "gitlab") {
		// The repository is the last segment before `/-/`, everything before it is the owner
		const end = segments.includes("-") ? segments.indexOf("-") : segments.length;
		return { owner: segments.slice(0, end - 1).join("/"), repo: segments[end - 1], route: segments.slice(end + 1) };
	}
	if (forge === "gitcafe" && segments[0] === "api" && segments[1] === "repos")
		return { owner: segments[2], repo: segments[3], route: ["api", ...segments.slice(4)] };
	// raw.githubusercontent.com/<owner>/<repo>/<ref>/<path> is github.com/<owner>/<repo>/raw/<ref>/<path>
	if (host === RAW_GITHUB) return { owner: segments[0], repo: segments[1], route: ["raw", ...segments.slice(2)] };
	return { owner: segments[0], repo: segments[1], route: segments.slice(2) };
};

/** A blob, tree or raw route: `<ref>/<path>`, or `refs/heads/<branch>/<path>` and `refs/tags/<tag>/<path>` */
const fileTarget = (kind: "blob" | "tree" | "raw", segments: string[]): Target | undefined => {
	const refEnd = segments[0] === "refs" && (segments[1] === "heads" || segments[1] === "tags") ? 3 : 1;
	if (segments.length < refEnd) return undefined;
	const ref = decode(segments.slice(refEnd - 1, refEnd));
	const path = decode(segments.slice(refEnd)) || undefined;
	// Only a folder can be the root of a ref
	if (ref === undefined || (path === undefined && kind !== "tree")) return undefined;
	return { kind, ref, path };
};

/** A release tag may hold `/` (`plugin/v1.2`), so it is every segment up to the asset's file name */
const releaseTarget = (tag: string[], asset?: string): Target =>
	tag.length === 0 ? REPO : { kind: "release", tag: decode(tag), asset: asset === undefined ? undefined : decode([asset]) };

const routeTarget = (forge: GitForge, [type, ...rest]: string[], query: URLSearchParams): Target => {
	switch (type) {
		case "src":
		case "raw":
			// Gitea and Forgejo name the kind of ref: /src/branch/main/<path>, /raw/commit/<sha>/<path>
			if (forge === "gitea" && /^(branch|tag|commit)$/.test(rest[0])) return fileTarget(type === "src" ? "blob" : "raw", rest.slice(1)) ?? REPO;
			return type === "raw" ? (fileTarget("raw", rest) ?? REPO) : REPO;
		case "blob":
		case "tree":
			return fileTarget(type, rest) ?? REPO;
		case "commit":
			return rest[0] === undefined ? REPO : { kind: "commit", sha: rest[0] };
		case "releases": {
			// GitLab: /-/releases/<tag>, /-/releases/<tag>/downloads/<file>
			if (forge === "gitlab") {
				const downloads = rest.lastIndexOf("downloads");
				return downloads > 0 ? releaseTarget(rest.slice(0, downloads), rest.at(-1)) : releaseTarget(rest);
			}
			// Others: /releases/tag/<tag>, /releases/download/<tag>/<file>
			if (rest[0] === "tag") return releaseTarget(rest.slice(1));
			if (rest[0] === "download" && rest.length >= 3) return releaseTarget(rest.slice(1, -1), rest.at(-1));
			return REPO;
		}
		case "api": {
			if (forge !== "gitcafe") return REPO;
			if (rest[0] === "raw") {
				const ref = query.get("ref") ?? undefined;
				const path = query.get("path")?.replace(/^\/+/, "") || undefined;
				return { kind: "raw", ref, path };
			}
			// Release assets are addressed by release and asset ids, not by tag and file name
			return rest[0] === "releases" ? { kind: "release" } : REPO;
		}
		default:
			return REPO;
	}
};

type ForgeRoutes = {
	/** Between the repository and its pages: GitLab's `/-` */
	pages: "" | "/-";
	commits: string;
	/** Undefined where the forge has no compare page */
	compare?: string;
	release: string;
	blob: (ref: string) => string;
	raw: (git: GitUrl, ref: string, path: string) => string;
};

/** Gitea and Forgejo route files by the kind of ref. A full sha is a commit; anything else is taken as a branch */
const giteaRef = (ref: string): string => (/^[0-9a-f]{40}$/i.test(ref) ? "commit" : "branch");

const ROUTES: Record<GitForge, ForgeRoutes> = {
	github: {
		pages: "",
		commits: "commits",
		compare: "compare",
		release: "releases/tag",
		blob: () => "blob",
		raw: (git, ref, path) => `https://${RAW_GITHUB}/${git.owner}/${git.repo}/${encodePath(ref)}/${encodePath(path)}`,
	},
	gitlab: {
		pages: "/-",
		commits: "commits",
		compare: "compare",
		release: "releases",
		blob: () => "blob",
		raw: (git, ref, path) => `${git.repoUrl}/-/raw/${encodePath(ref)}/${encodePath(path)}`,
	},
	gitea: {
		pages: "",
		commits: "commits/branch",
		compare: "compare",
		release: "releases/tag",
		blob: (ref) => `src/${giteaRef(ref)}`,
		raw: (git, ref, path) => `${git.repoUrl}/raw/${giteaRef(ref)}/${encodePath(ref)}/${encodePath(path)}`,
	},
	gitcafe: {
		pages: "",
		commits: "commits",
		release: "releases/tag",
		blob: () => "blob",
		raw: (git, ref, path) => `${git.origin}/api/repos/${git.owner}/${git.repo}/raw?${new URLSearchParams({ ref, path })}`,
	},
};

/**
 * A url of a git repository, or of something in one (file, folder, raw file, release, release asset, commit), and the links
 * of that repository. Parse urls with GitUrl.from (memoized per url) or GitUrl.fromRepository.
 */
export class GitUrl {
	/** Parse a url, undefined if it is not an http(s) url of a git repository. Memoized: the same url returns the same instance */
	public static readonly from: (url: string) => GitUrl | undefined = memoize((text: string): GitUrl | undefined => {
		const url = httpUrl(text);
		if (url === undefined) return undefined;
		const host = url.hostname.toLowerCase();
		const segments = url.pathname.split("/").filter(Boolean);
		const forge = forgeOf(host, segments);
		const { owner, repo, route } = locateRepo(forge, host, segments);
		const repoName = repo?.replace(/\.git$/, "");
		if (!owner || !repoName) return undefined;
		// A raw file's repository lives on github.com
		const origin = host === RAW_GITHUB ? "https://github.com" : url.origin;
		return new GitUrl({ forge, origin, owner, repo: repoName, ...routeTarget(forge, route, url.searchParams) });
	});

	/** A package.json `repository`: a string or `{ url }`, as a url, `git+https://host/owner/repo.git`, `owner/repo` or `github:owner/repo` */
	public static fromRepository(repository: unknown): GitUrl | undefined {
		const text = typeof repository === "object" && repository !== null ? (repository as { url?: unknown }).url : repository;
		if (typeof text !== "string") return undefined;
		const shorthand = text.trim().match(/^(?:github:)?([\w.-]+)\/([\w.-]+)$/);
		if (shorthand !== null) return GitUrl.from(`https://github.com/${shorthand[1]}/${shorthand[2]}`);
		return GitUrl.from(text.trim().replace(/^git\+/, ""));
	}

	declare public readonly forge: GitForge;
	/** Web origin of the repository, `https://host` */
	declare public readonly origin: string;
	/** Owner of the repository, `group/sub` for a GitLab subgroup */
	declare public readonly owner: string;
	/** Repository name, without `.git` */
	declare public readonly repo: string;
	declare public readonly kind: GitUrlKind;
	/** Branch, tag or commit of a blob, tree or raw url */
	declare public readonly ref?: string;
	/** Path of a blob, tree or raw url inside the repository, decoded, without leading `/` */
	declare public readonly path?: string;
	/** Tag of a release or release asset url, decoded */
	declare public readonly tag?: string;
	/** Commit of a commit url */
	declare public readonly sha?: string;
	/** File name of a release asset url, decoded */
	declare public readonly asset?: string;

	public constructor(parts: GitUrlParts) {
		Object.assign(this, parts);
	}

	public get host(): string {
		return new URL(this.origin).host;
	}
	/** File or folder name of a blob, tree or raw url, or a release asset's file name */
	public get fileName(): string | undefined {
		return this.path?.split("/").at(-1) ?? this.asset;
	}
	/** `https://host/owner/repo` */
	public get repoUrl(): string {
		return `${this.origin}/${this.owner}/${this.repo}`;
	}
	/** Readable page of the file of a blob or raw url */
	public get browseUrl(): string | undefined {
		const file = this.file;
		return file && this.blobUrl(file.ref, file.path);
	}
	/** Fetchable file of a blob or raw url */
	public get rawUrl(): string | undefined {
		const file = this.file;
		return file && this.rawFileUrl(file.ref, file.path);
	}

	public commitUrl(sha: string): string {
		return this.page("commit", encodeURIComponent(sha));
	}
	public commitsUrl(ref: string): string {
		return this.page(this.routes.commits, encodePath(ref));
	}
	/** What changed between two commits, undefined where the forge has no compare page (gitcafe) */
	public compareUrl(from: string, to: string): string | undefined {
		const { compare } = this.routes;
		return compare && this.page(compare, `${encodePath(from)}...${encodePath(to)}`);
	}
	public releaseUrl(tag: string): string {
		return this.page(this.routes.release, encodeURIComponent(tag));
	}
	public blobUrl(ref: string, path: string): string {
		return this.page(this.routes.blob(ref), encodePath(ref), encodePath(path));
	}
	public rawFileUrl(ref: string, path: string): string {
		return this.routes.raw(this, ref, path);
	}

	private get routes(): ForgeRoutes {
		return ROUTES[this.forge];
	}
	private page(...route: string[]): string {
		return [`${this.repoUrl}${this.routes.pages}`, ...route].join("/");
	}
	/** Ref and path of a blob or raw url */
	private get file(): { ref: string; path: string } | undefined {
		if ((this.kind !== "blob" && this.kind !== "raw") || this.ref === undefined || this.path === undefined) return undefined;
		return { ref: this.ref, path: this.path };
	}
}
