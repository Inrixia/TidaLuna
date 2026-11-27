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

/**
 * A url of a git repository or of something in one (file page, raw file, release asset, commit), parsed once.
 * Get instances through GitUrl.from (memoized per url) or GitUrl.fromRepository, never the constructor.
 */
export class GitUrl {
	/** Parse a url, undefined if it is not an http(s) url of a git repository. Memoized: the same url string returns the same instance */
	public static readonly from: (url: string) => GitUrl | undefined = memoize((url: string): GitUrl | undefined => {
		throw new Error("GitUrl.from: not implemented");
	});

	/** A package.json `repository`: a string or `{ url }`, as a url, `git+https://host/owner/repo.git`, `owner/repo` or `github:owner/repo` */
	public static fromRepository(repository: unknown): GitUrl | undefined {
		throw new Error("GitUrl.fromRepository: not implemented");
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
	) {}

	public get host(): string {
		return new URL(this.origin).host;
	}
	/** Last path segment, decoded (file name of a blob/raw url or release asset), if any */
	public get fileName(): string | undefined {
		throw new Error("GitUrl.fileName: not implemented");
	}

	/** Web page of the repository: `https://host/owner/repo` (`.git` dropped) */
	public get repoUrl(): string {
		throw new Error("GitUrl.repoUrl: not implemented");
	}
	/** Readable page of the file (blob page), for a blob or raw url */
	public get browseUrl(): string | undefined {
		throw new Error("GitUrl.browseUrl: not implemented");
	}
	/** Fetchable file, for a blob or raw url */
	public get rawUrl(): string | undefined {
		throw new Error("GitUrl.rawUrl: not implemented");
	}

	public commitUrl(sha: string): string | undefined {
		throw new Error("GitUrl.commitUrl: not implemented");
	}
	public commitsUrl(ref: string): string | undefined {
		throw new Error("GitUrl.commitsUrl: not implemented");
	}
	/** What changed between two commits, undefined where the forge has no compare page (gitcafe) */
	public compareUrl(from: string, to: string): string | undefined {
		throw new Error("GitUrl.compareUrl: not implemented");
	}
	public releaseUrl(tag: string): string | undefined {
		throw new Error("GitUrl.releaseUrl: not implemented");
	}
	public blobUrl(ref: string, path: string): string | undefined {
		throw new Error("GitUrl.blobUrl: not implemented");
	}
	public rawFileUrl(ref: string, path: string): string | undefined {
		throw new Error("GitUrl.rawFileUrl: not implemented");
	}
}
