import { type GitUrl } from "@luna/lib";

export type UpdateSide = { version?: string; commit?: string; sha256?: string };
export type UpdateLinks = { from?: string; to?: string; compare?: string; release?: { tag: string; page: string } };

const isCommit = (commit?: string): commit is string => commit !== undefined && /^[0-9a-f]{7,40}$/i.test(commit);

/** Source links for an update: commit/release links for each version, compare between commits, and any moving release */
export const updateLinks = (from: UpdateSide, to: UpdateSide, git?: GitUrl, releaseTag?: string): UpdateLinks => {
	const isVersionTag = releaseTag !== undefined && to.version !== undefined && (releaseTag === to.version || releaseTag === `v${to.version}`);
	const releasePage = releaseTag && !isVersionTag ? git?.releaseUrl(releaseTag) : undefined;
	return {
		from: isCommit(from.commit) ? git?.commitUrl(from.commit) : undefined,
		to: (isCommit(to.commit) ? git?.commitUrl(to.commit) : undefined) ?? (isVersionTag ? git?.releaseUrl(releaseTag) : undefined),
		compare: isCommit(from.commit) && isCommit(to.commit) && from.commit !== to.commit ? git?.compareUrl(from.commit, to.commit) : undefined,
		release: releasePage !== undefined && releaseTag !== undefined ? { tag: releaseTag, page: releasePage } : undefined,
	};
};
