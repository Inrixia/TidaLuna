import type { LunaAuthor } from "@luna/core";

import Box, { type BoxProps } from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import React, { type PropsWithChildren, type ReactNode } from "react";

import { LunaAuthorDisplay, LunaLink } from "../../components";
import { PluginStatusBadge, type PluginStatus } from "./PluginStatusBadge";

export interface LunaPluginComponentProps extends PropsWithChildren {
	name: string;
	version?: string;
	link?: string;
	loadError?: string;
	author?: LunaAuthor | string;
	desc?: ReactNode;
	sx?: BoxProps["sx"];
	enabled?: boolean;
	loading?: boolean;
}

// Determine plugin status based on state
const getPluginStatus = (enabled: boolean, loading: boolean, loadError?: string): PluginStatus => {
	if (!enabled) return "disabled";
	if (loadError) return "error";
	if (loading) return "warning";
	return "working";
};

export const LunaPluginHeader = React.memo(({ name, version, loadError, author, desc, children, sx, link, enabled = true, loading = false }: LunaPluginComponentProps) => {
	const status = getPluginStatus(enabled, loading, loadError);

	return (
		<Box sx={sx}>
			<Stack direction="row" alignItems="center" spacing={1}>
				<PluginStatusBadge status={status} />
				<Typography variant="h6">
					<LunaLink href={link}>{name}</LunaLink>
					{version && <Typography variant="caption" style={{ opacity: 0.7, marginLeft: 6 }} children={version} />}
				</Typography>
				{children}
				<Box sx={{ flexGrow: 1 }} /> {/* This pushes the author section to the right */}
				{author && <LunaAuthorDisplay author={author} />}
			</Stack>
			{desc && <Typography variant="subtitle2" gutterBottom dangerouslySetInnerHTML={{ __html: desc }} />}
		</Box>
	);
});
