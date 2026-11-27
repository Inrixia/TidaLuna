// Not Partial<PluginPackage>: build/ ships as TS source to third-party plugin repos (luna/build) and must not import render types
export type PluginSource = { commit?: string; repository?: { type: string; url: string } };

/**
 * Where a plugin build comes from, written into its .json so Luna's update dialog can link what changed (compare of
 * the two builds' commits). From the CI's environment: GitHub Actions, Gitea and Forgejo Actions all set GITHUB_SHA,
 * GITHUB_SERVER_URL and GITHUB_REPOSITORY. A package.json `repository` is kept as it is. Local builds add nothing, and
 * pull request and merge queue builds no commit (GITHUB_SHA is then a temporary merge commit).
 */
export const buildSource = (env: Record<string, string | undefined>, pkg: { repository?: unknown }): PluginSource => {
	const source: PluginSource = {};
	if (!/^(pull_request|merge_group)/.test(env.GITHUB_EVENT_NAME ?? "") && /^[0-9a-f]{40}$/i.test(env.GITHUB_SHA ?? ""))
		source.commit = env.GITHUB_SHA;
	const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo } = env;
	if (pkg.repository === undefined && server?.startsWith("https://") && repo !== undefined && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
		source.repository = { type: "git", url: `${server.replace(/\/+$/, "")}/${repo}` };
	}
	return source;
};
