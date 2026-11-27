import React from "react";

import { formatBytes, type CacheControl } from "@luna/core";

import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import { useConfirm } from "material-ui-confirm";

import FolderOpenIcon from "@mui/icons-material/FolderOpen";

import { LunaTitle } from "../../LunaTitle";
import { LunaTrashButton } from "../../LunaTrashButton";
import { LunaCacheLimit } from "./LunaCacheLimit";
import { LunaCacheStats } from "./LunaCacheStats";
import { keyTitle } from "./formatStats";
import { trace, useCacheStats } from "./useCacheStats";

export { useCacheStats } from "./useCacheStats";

export type LunaCacheSettingProps = {
	cache: CacheControl;
	/** Settings of what fills the cache, shown under its limit */
	children?: React.ReactNode;
};

/** A card of a cache, everything on it read from `cache`: what it holds, how full, its use this session, its limit, location and clearing */
export const LunaCacheSetting = React.memo(({ cache, children }: LunaCacheSettingProps) => {
	const stats = useCacheStats(cache);
	const confirm = useConfirm();
	const title = keyTitle(cache.key);

	const clear = React.useCallback(async () => {
		const { confirmed } = await confirm({
			title: `Clear the ${title.toLowerCase()} cache?`,
			description: stats && `Deletes ${stats.entries.toLocaleString()} entries (${formatBytes(stats.bytes)}), except those in use.`,
			confirmationText: "Clear",
		});
		if (confirmed) await cache.clear().catch(trace.msg.err.withContext(`Failed to clear the ${cache.key} cache`));
	}, [cache, confirm, stats, title]);

	return (
		<Stack spacing={1.5} sx={{ borderRadius: 3, backgroundColor: "rgba(0, 0, 0, 0.10)", padding: 2 }}>
			<Stack direction="row" sx={{ alignItems: "flex-start" }}>
				<Box sx={{ flexGrow: 1 }} children={<LunaTitle variant="h7" title={title} desc={stats?.desc} />} />
				{cache.openLocation && (
					<Tooltip title={`Open ${stats?.persist?.data.location ?? "the cache folder"}`}>
						<IconButton onClick={() => cache.openLocation!()} children={<FolderOpenIcon />} />
					</Tooltip>
				)}
				<LunaTrashButton title={`Clear the ${title.toLowerCase()} cache`} disabled={!stats?.entries} onClick={clear} />
			</Stack>
			{stats ? <LunaCacheStats stats={stats} /> : <Skeleton variant="rounded" height={96} />}
			<LunaCacheLimit cache={cache} stats={stats} />
			{children}
		</Stack>
	);
});
