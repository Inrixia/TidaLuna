import React from "react";

import Typography from "@mui/material/Typography";
import { shortHash, type GitUrl } from "@luna/lib";

import { LunaLink } from "./LunaLink";
import { updateLinks, type UpdateSide } from "./updateLinks";

export type UpdateDetailsProps = {
	from: UpdateSide;
	to: UpdateSide;
	/** Repository to link versions/commits/compare against */
	git?: GitUrl;
	/** Tag of the release the code is downloaded from (may be a moving tag like `latest`) */
	releaseTag?: string;
	/** Shown in the trust line, linked to trustHref ?? trustUrl */
	trustUrl: string;
	trustHref?: string;
	children?: React.ReactNode;
};

/** What an update changes, with links to its source when known */
export const UpdateDetails = ({ from, to, git, releaseTag, trustUrl, trustHref, children }: UpdateDetailsProps) => {
	const links = updateLinks(from, to, git, releaseTag);
	return (
		<>
			<Typography variant="body2" gutterBottom>
				<LunaLink href={links.from}>
					<b>{from.version ?? "?"}</b>
				</LunaLink>
				{" → "}
				<LunaLink href={links.to}>
					<b>{to.version ?? "?"}</b>
				</LunaLink>
				{links.release !== undefined && (
					<>
						{" ("}
						<LunaLink href={links.release.page}>release {links.release.tag}</LunaLink>)
					</>
				)}
			</Typography>
			{(from.sha256 !== undefined || to.sha256 !== undefined) && (
				<Typography variant="body2" gutterBottom title={`sha256 ${from.sha256 ?? "?"} → ${to.sha256 ?? "?"}`}>
					Code sha256: <code>{shortHash(from.sha256)}</code> → <code>{shortHash(to.sha256)}</code>
					{links.compare !== undefined && (
						<>
							{" ("}
							<LunaLink href={links.compare}>changes</LunaLink>)
						</>
					)}
				</Typography>
			)}
			<Typography variant="body2">
				Update only if you trust the author and <LunaLink href={trustHref ?? trustUrl}>{trustUrl}</LunaLink>
			</Typography>
			{children}
		</>
	);
};
