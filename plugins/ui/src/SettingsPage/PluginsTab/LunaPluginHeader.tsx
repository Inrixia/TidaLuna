import type { LunaAuthor } from "@luna/core";

import Box, { type BoxProps } from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import React, { type PropsWithChildren, type ReactNode } from "react";

import { LunaAuthorDisplay, LunaLink } from "../../components";

export interface LunaPluginComponentProps extends PropsWithChildren {
	name: string;
	version?: string;
	link?: string;
	loadError?: string;
	author?: LunaAuthor | string;
	desc?: ReactNode;
	isLibrary?: boolean;
	dependsOn?: string[];
	sx?: BoxProps["sx"];
}
export const LunaPluginHeader = React.memo(({ name, version, loadError, author, desc, isLibrary, dependsOn, children, sx, link }: LunaPluginComponentProps) => (
	<Box sx={sx}>
		<Stack direction="row" alignItems="center" spacing={1}>
			<Typography variant="h6">
				<LunaLink href={link}>{name}</LunaLink>
				{version && <Typography variant="caption" style={{ opacity: 0.7, marginLeft: 6 }} children={version} />}
			</Typography>
			{children}
			{loadError && (
				<Typography
					variant="caption"
					sx={{
						color: "white",
						fontWeight: 500,
						backgroundColor: "rgba(256, 0, 0, 0.5)",
						padding: 1,
						borderRadius: 1,
						paddingTop: 1.5,
					}}
					children={loadError}
				/>
			)}
			<Box sx={{ flexGrow: 1 }} /> {/* This pushes the author section to the right */}
			{author && <LunaAuthorDisplay author={author} />}
		</Stack>
		{desc && <Typography variant="subtitle2" gutterBottom dangerouslySetInnerHTML={{ __html: desc }} />}
		{(isLibrary || (dependsOn?.length ?? 0) > 0) && (
			<Stack direction="row" spacing={1} alignItems="center" sx={{ opacity: 0.8 }}>
				{isLibrary && <Typography variant="caption">Library</Typography>}
				{(dependsOn?.length ?? 0) > 0 && <Typography variant="caption">Depends on: {dependsOn?.join(", ")}</Typography>}
			</Stack>
		)}
	</Box>
));
