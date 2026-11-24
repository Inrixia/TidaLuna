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

/** An http(s) url as given, or undefined for anything else (links shown in the update dialog) */
const httpUrl = (text: unknown): URL | undefined => {
	if (typeof text !== "string") return undefined;
	try {
		const url = new URL(text);
		return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
	} catch {
		return undefined;
	}
};

/** `https://host/owner/repo` of a url whose path starts with /owner/repo, `.git` dropped */
const repoBase = (url: URL | undefined): string | undefined => {
	const [owner, repo] = url?.pathname.split("/").filter(Boolean) ?? [];
	if (url === undefined || owner === undefined || repo === undefined) return undefined;
	return `${url.origin}/${owner}/${repo.replace(/\.git$/, "")}`;
};

/** A GitHub or Gitea/Forgejo release asset url: `https://host/owner/repo/releases/download/<tag>/<file>` */
const releaseAsset = (url: string): { repo: string; tag: string } | undefined => {
	const parsed = httpUrl(url);
	const match = parsed?.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\//);
	if (parsed === undefined || match === null || match === undefined) return undefined;
	return { repo: `${parsed.origin}/${match[1]}/${match[2]}`, tag: decodeURIComponent(match[3]) };
};

/**
 * The web page of the repository a plugin is built from: the repository of the release its url downloads from (where
 * the code really comes from), else the `repository.url` its package names (`git+https://...git` too)
 */
export const sourceRepo = (pkg: { repository?: { url?: string } }, url: string): string | undefined =>
	releaseAsset(url)?.repo ?? repoBase(httpUrl(typeof pkg.repository?.url === "string" ? pkg.repository.url.replace(/^git\+/, "") : undefined));

/** The release a plugin url downloads from (GitHub, Gitea and Forgejo use the same paths) */
export const releaseOf = (url: string): { tag: string; page: string } | undefined => {
	const asset = releaseAsset(url);
	return asset === undefined ? undefined : { tag: asset.tag, page: `${asset.repo}/releases/tag/${encodeURIComponent(asset.tag)}` };
};

const isCommit = (commit: unknown): commit is string => typeof commit === "string" && /^[0-9a-f]{7,40}$/i.test(commit);

/** The page of a commit's files, when the package names the commit it was built from */
export const commitPage = (repo: string | undefined, commit: unknown): string | undefined =>
	repo !== undefined && isCommit(commit) ? `${repo}/tree/${commit}` : undefined;

/** What changed between the commits two builds were made from (`/compare/a...b` on GitHub, Gitea and Forgejo) */
export const comparePage = (repo: string | undefined, from: unknown, to: unknown): string | undefined =>
	repo !== undefined && isCommit(from) && isCommit(to) && from !== to ? `${repo}/compare/${from}...${to}` : undefined;

/** A native permission answer as `__Luna.nativePermissions.list` returns it (native/NativeModule/trust.ts) */
export type PermissionEntry = { key: string; fileName: string; url?: string; claimedUrl?: string; answer: string };

/** The plugin's native files the user allowed for all versions: an update's code for them runs without asking again */
export const allowedForAllVersions = <T extends PermissionEntry>(entries: T[], url: string): T[] =>
	entries.filter((entry) => entry.answer === "allowUpdates" && (entry.url ?? entry.claimedUrl) === url);

type SourceInfo = { repository?: { url?: string }; version?: string; commit?: string };

/**
 * Links for an update of the plugin at `url`. The repository is the release's, else the one the installed version
 * named, else the update's (a package's commit and repository are what its build says, not checked against the code):
 * - from / to: each version's commit, or the release when its tag is that version
 * - release: the release the url downloads from when its tag is not the version (`latest`, `dev`: it moves on)
 * - compare: the two builds' commits
 */
export const updateLinks = (
	url: string,
	current: SourceInfo,
	update: SourceInfo,
): { from?: string; to?: string; compare?: string; release?: { tag: string; page: string } } => {
	const repo = sourceRepo(current, url) ?? sourceRepo(update, url);
	const release = releaseOf(url);
	const versionRelease =
		release !== undefined && update.version !== undefined && (release.tag === update.version || release.tag === `v${update.version}`)
			? release.page
			: undefined;
	const to = commitPage(repo, update.commit) ?? versionRelease;
	return {
		from: commitPage(repo, current.commit),
		to,
		compare: comparePage(repo, current.commit, update.commit),
		release: to === undefined ? release : undefined,
	};
};
