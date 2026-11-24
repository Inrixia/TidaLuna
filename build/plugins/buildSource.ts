/**
 * Where a plugin build comes from, written into its .json so Luna's update dialog can link what changed (compare of
 * the two builds' commits). From the CI's environment: GitHub Actions, Gitea and Forgejo Actions all set GITHUB_SHA,
 * GITHUB_SERVER_URL and GITHUB_REPOSITORY. A package.json `repository` is kept as it is. Local builds add nothing, and
 * pull request builds no commit (GITHUB_SHA is then a temporary merge commit).
 */
export const buildSource = (
	env: Record<string, string | undefined>,
	pkg: { repository?: unknown },
): { commit?: string; repository?: { type: string; url: string } } => {
	const source: { commit?: string; repository?: { type: string; url: string } } = {};
	if (!env.GITHUB_EVENT_NAME?.startsWith("pull_request") && /^[0-9a-f]{40}$/i.test(env.GITHUB_SHA ?? "")) source.commit = env.GITHUB_SHA;
	const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo } = env;
	if (pkg.repository === undefined && server?.startsWith("https://") && repo !== undefined && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
		source.repository = { type: "git", url: `${server.replace(/\/+$/, "")}/${repo}` };
	}
	return source;
};
