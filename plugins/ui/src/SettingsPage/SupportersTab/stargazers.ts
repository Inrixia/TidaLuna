import { ftch } from "@luna/core";

/**
 * Public, no token: the repo endpoint carries `stargazers_count`. GitHub's stargazer *list* endpoint
 * (`/repos/{owner}/{repo}/stargazers`) answers 401 "Requires authentication" without one, so the count is all the page
 * can show anonymously.
 */
export const REPO_API = "https://api.github.com/repos/Inrixia/TidaLuna";
/** Where someone who wants the names reads them, in their own browser and with their own session */
export const STARGAZERS_PAGE = "https://github.com/Inrixia/TidaLuna/stargazers";

/** The star count in a repo response, or undefined when it does not carry one */
export const parseStarCount = (repo: unknown): number | undefined => {
	if (typeof repo !== "object" || repo === null) return undefined;
	const count = (repo as { stargazers_count?: unknown }).stargazers_count;
	return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : undefined;
};

/** What `loadStarCount` needs of a json fetcher: the body is checked here, so it is taken as unknown */
export type FetchJson = (url: string) => Promise<unknown>;

/**
 * The count GitHub gives without a token, or undefined when the request fails or the response has none. Never throws:
 * the tab is informational, and a rate-limited or offline request must not break the settings page
 */
export const loadStarCount = async (fetchJson: FetchJson = ftch.json): Promise<number | undefined> => {
	try {
		return parseStarCount(await fetchJson(REPO_API));
	} catch {
		return undefined;
	}
};
