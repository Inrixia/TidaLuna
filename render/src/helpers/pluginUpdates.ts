/**
 * Whether new code fetched for a plugin waits for the user (LunaPlugin.acceptUpdate) instead of replacing the code that runs.
 * Dev plugins, live reload (the user asked for every change) and Luna's own plugins update without asking,
 * and a plugin without stored code (first install) has nothing else to run.
 */
export const updateWaitsForUser = (plugin: {
	codeChanged: boolean;
	hasCode: boolean;
	isDev: boolean;
	liveReload: boolean;
	isCore: boolean;
}): boolean => plugin.codeChanged && plugin.hasCode && !plugin.isDev && !plugin.liveReload && !plugin.isCore;

/**
 * Luna's own plugins are served from https://luna/ (part of the Luna build): they update without asking and are not in the plugin registry.
 * By url, not by name: any plugin can name itself like a core plugin, only Luna serves https://luna/.
 */
export const isCoreUrl = (url: string): boolean => url.startsWith("https://luna/");

/**
 * A dev plugin is served from this machine (`slot.mjs serve`, `pnpm watch`): http on host 127.0.0.1, any port.
 * Checked by host, not by prefix, so `http://127.0.0.1.example.com` or `http://127.0.0.1@example.com` don't count (dev plugins skip the update prompt).
 */
export const isDevUrl = (url: string): boolean => {
	try {
		const { protocol, hostname } = new URL(url);
		return protocol === "http:" && hostname === "127.0.0.1";
	} catch {
		return false;
	}
};

/**
 * The text LunaPlugin.loadExports imports for a plugin's code.
 * Native code registering names the plugin's url, so its permissions are kept per plugin (see native/NativeModule/trust.ts).
 * Only the call build/plugins/lunaNativePlugin.ts emits, not the same text inside a native file's code string.
 */
export const codeToImport = (code: string, url: string): string =>
	code.replace(
		/(__ipcRenderer\.invoke\(\s*)(["'`])__Luna\.registerNative\2\s*,/g,
		(_, call) => `${call}"__Luna.registerNativeFrom",${JSON.stringify(url)},`,
	);

/** sha256 of the text as UTF-8, lowercase hex */
export const sha256Hex = async (text: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** An http(s) url as given, or undefined for anything else */
const httpUrl = (text: unknown): URL | undefined => {
	if (typeof text !== "string") return undefined;
	try {
		const url = new URL(text);
		return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
	} catch {
		return undefined;
	}
};

/**
 * `https://host/owner/repo` of a url whose path starts with /owner/repo, `.git` dropped. Only two path parts: a GitLab
 * subgroup repository (`group/sub/repo`) gets no links.
 */
const repoBase = (url: URL | undefined): string | undefined => {
	const [owner, repo] = url?.pathname.split("/").filter(Boolean) ?? [];
	if (url === undefined || owner === undefined || repo === undefined) return undefined;
	return `${url.origin}/${owner}/${repo.replace(/\.git$/, "")}`;
};

/** A package.json `repository`: `{ url }`, a url, or the `github:owner/repo` and `owner/repo` shorthands */
const declaredRepo = (repository: unknown): string | undefined => {
	const text = typeof repository === "string" ? repository : (repository as { url?: unknown } | undefined)?.url;
	if (typeof text !== "string") return undefined;
	const shorthand = text.match(/^(?:github:)?([\w.-]+)\/([\w.-]+)$/);
	if (shorthand !== null) return repoBase(httpUrl(`https://github.com/${shorthand[1]}/${shorthand[2]}`));
	return repoBase(httpUrl(text.replace(/^git\+/, "")));
};

/**
 * A GitHub or Gitea/Forgejo release asset url: `https://host/owner/repo/releases/download/<tag>/<file>`. A tag may
 * hold `/` (`plugin/v1.2`): it is everything up to the file name.
 */
const releaseAsset = (url: string): { repo: string; tag: string } | undefined => {
	const parsed = httpUrl(url);
	const match = parsed?.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/(.+)\/[^/]+$/);
	if (parsed === undefined || match === null || match === undefined) return undefined;
	try {
		return { repo: `${parsed.origin}/${match[1]}/${match[2]}`, tag: decodeURIComponent(match[3]) };
	} catch {
		// A malformed escape (%E0): no release link
		return undefined;
	}
};

type SourceInfo = { repository?: unknown; version?: string; commit?: unknown };

/**
 * The web page of the repository a plugin is built from: the repository of the release its url downloads from (where
 * the code really comes from), else the `repository` its package names
 */
export const sourceRepo = (pkg: SourceInfo, url: string): string | undefined => releaseAsset(url)?.repo ?? declaredRepo(pkg.repository);

/** The release a plugin url downloads from (GitHub, Gitea and Forgejo use the same paths) */
export const releaseOf = (url: string): { tag: string; page: string } | undefined => {
	const asset = releaseAsset(url);
	return asset === undefined ? undefined : { tag: asset.tag, page: `${asset.repo}/releases/tag/${encodeURIComponent(asset.tag)}` };
};

const isCommit = (commit: unknown): commit is string => typeof commit === "string" && /^[0-9a-f]{7,40}$/i.test(commit);

/** The page of a commit, when the package names the commit it was built from (`/commit/<sha>` on GitHub, Gitea and Forgejo) */
export const commitPage = (repo: string | undefined, commit: unknown): string | undefined =>
	repo !== undefined && isCommit(commit) ? `${repo}/commit/${commit}` : undefined;

/** What changed between the commits two builds were made from (`/compare/a...b` on GitHub, Gitea and Forgejo) */
export const comparePage = (repo: string | undefined, from: unknown, to: unknown): string | undefined =>
	repo !== undefined && isCommit(from) && isCommit(to) && from !== to ? `${repo}/compare/${from}...${to}` : undefined;

/**
 * Links for an update of the plugin at `url`. The repository is the release's, else the one the installed version
 * named, else the update's (a package's commit and repository are what its build says, not checked against the code):
 * - from / to: each version's commit, else for the update the release when its tag is that version
 * - release: the release the url downloads from when its tag is not the update's version (`latest`, `dev`: it moves on)
 * - compare: the two builds' commits
 */
export const updateLinks = (
	url: string,
	current: SourceInfo,
	update: SourceInfo,
): { from?: string; to?: string; compare?: string; release?: { tag: string; page: string } } => {
	const repo = sourceRepo(current, url) ?? sourceRepo(update, url);
	const release = releaseOf(url);
	const isVersionTag =
		release !== undefined && update.version !== undefined && (release.tag === update.version || release.tag === `v${update.version}`);
	return {
		from: commitPage(repo, current.commit),
		to: commitPage(repo, update.commit) ?? (isVersionTag ? release.page : undefined),
		compare: comparePage(repo, current.commit, update.commit),
		release: isVersionTag ? undefined : release,
	};
};

/** A native permission answer as `__Luna.nativePermissions.list` returns it (native/NativeModule/trust.ts) */
export type PermissionEntry = { key: string; fileName: string; url?: string; claimedUrl?: string; answer: string };

/** The plugin's native files the user allowed for all versions: an update's code for them runs without asking again */
export const allowedForAllVersions = <T extends PermissionEntry>(entries: T[], url: string): T[] =>
	entries.filter((entry) => entry.answer === "allowUpdates" && (entry.url ?? entry.claimedUrl) === url);
