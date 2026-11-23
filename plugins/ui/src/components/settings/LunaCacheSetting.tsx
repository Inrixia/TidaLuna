import React from "react";

import { Tracer, unloadSet, type LunaUnloads } from "@luna/core";
import type { Cache, DiskCacheStats } from "@luna/lib";

import Typography from "@mui/material/Typography";
import { useConfirm } from "material-ui-confirm";

import { LunaButtonSetting } from "./LunaButtonSetting";
import { LunaNumberSetting } from "./LunaNumberSetting";

const { trace } = Tracer("[@luna/ui]", null);

const GB = 1024 ** 3;
export const formatBytes = (bytes: number) => (bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

/** The stats of `cache`, kept up to date while mounted */
export const useCacheStats = (cache: Cache) => {
	const [stats, setStats] = React.useState<DiskCacheStats>();
	React.useEffect(() => {
		const unloads: LunaUnloads = new Set();
		cache.onStats(unloads, setStats);
		return () => void unloadSet(unloads);
	}, [cache]);
	return stats;
};

export type LunaCacheSettingProps = {
	cache: Cache;
	/** What the cache is, e.g. "Audio" */
	title: string;
	/** What the cache holds, shown with how much of the limit it uses */
	desc: string;
	/** What the entries are called, e.g. "tracks" */
	entries?: string;
	/** Provider specific lines under the stats, from `DiskCacheStats.extra` */
	details?: (stats: DiskCacheStats) => React.ReactNode;
};

/** The limit, folder and stats of a disk cache. A lower limit deletes entries, so it asks before applying */
export const LunaCacheSetting = React.memo(({ cache, title, desc, entries = "entries", details }: LunaCacheSettingProps) => {
	const stats = useCacheStats(cache);
	const confirm = useConfirm();

	// Applied when typing stops (Enter, leaving the field, or a pause), not per keystroke: typing "100" would otherwise first set 1 GB
	const [draftGb, setDraftGb] = React.useState<number>();
	const pendingGb = React.useRef<number>(undefined);
	const applyTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
	/** `canConfirm` false (leaving the page) drops a limit that would delete entries instead of asking */
	const applyLimit = React.useCallback(
		async (canConfirm = true) => {
			clearTimeout(applyTimer.current);
			const gb = pendingGb.current;
			if (gb === undefined) return;
			pendingGb.current = undefined;
			try {
				const bytes = Math.max(0, gb) * GB;
				const evicted = await cache.evictedBy(bytes);
				if (evicted > 0) {
					if (!canConfirm) return;
					const { confirmed } = await confirm({
						title: `Delete cached ${entries}?`,
						description: `A ${gb || "default"} GB limit deletes ${formatBytes(evicted)}, the least recently and frequently used ${entries} first.`,
						confirmationText: `Delete ${entries}`,
					});
					if (!confirmed) return;
				}
				await cache.setLimit(bytes);
			} catch (err) {
				trace.msg.err.withContext(`Failed to set the ${title} cache limit`)(err);
			} finally {
				// Shows the applied limit again, or the old one if it was cancelled or failed
				if (pendingGb.current === undefined) setDraftGb(undefined);
			}
		},
		[cache],
	);
	// Leaving the page applies what was typed
	React.useEffect(() => () => void applyLimit(false), [applyLimit]);

	const { hits = 0, misses = 0 } = stats ?? {};
	return (
		<>
			<LunaNumberSetting
				title={`${title} cache limit (GB)`}
				desc={
					stats &&
					`${desc} Using ${formatBytes(stats.usage)} of ${formatBytes(stats.limit)} in ${stats.entries} ${entries}. 0 for ${formatBytes(stats.defaultLimit)}`
				}
				min={0}
				value={draftGb ?? (stats === undefined ? 0 : Math.round((stats.userLimit ?? stats.defaultLimit) / GB))}
				onNumber={(gb) => {
					setDraftGb(gb);
					pendingGb.current = gb;
					clearTimeout(applyTimer.current);
					applyTimer.current = setTimeout(applyLimit, 2000);
				}}
				onBlur={() => applyLimit()}
				onKeyDown={(e) => e.key === "Enter" && applyLimit()}
			/>
			<LunaButtonSetting title={`Open ${title.toLowerCase()} cache folder`} desc={stats?.path} onClick={() => cache.openFolder()} children="Open" />
			{stats && (
				<Typography variant="body2" sx={{ paddingLeft: 2 }}>
					{hits} reads and {misses} misses, {stats.evictions} {entries} ({formatBytes(stats.evictedBytes)}) evicted this session
				</Typography>
			)}
			{stats && details?.(stats)}
		</>
	);
});
