import { GitUrl } from "@luna/lib";

/**
 * The repository to link an update against, and the release its code downloads from.
 * Only a release asset url says where the code comes from; any other plugin url is a store path, not a repository.
 * Otherwise the installed version's declared repository wins over the update's (the update could claim any repository).
 */
export const pluginUpdateSource = (url: string, current: { repository?: unknown }, update: { repository?: unknown }) => {
	const source = GitUrl.from(url);
	const release = source?.kind === "release" ? source : undefined;
	return { git: release ?? GitUrl.fromRepository(current.repository) ?? GitUrl.fromRepository(update.repository), releaseTag: release?.tag };
};
