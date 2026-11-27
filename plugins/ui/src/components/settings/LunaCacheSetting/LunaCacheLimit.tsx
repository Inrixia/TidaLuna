import React from "react";

import { formatBytes, type CacheControl, type CacheStats } from "@luna/core";

import { useConfirm } from "material-ui-confirm";

import { LunaNumberSetting } from "../LunaNumberSetting";
import { trace } from "./useCacheStats";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

export type LunaCacheLimitProps = {
	cache: CacheControl;
	stats?: CacheStats;
};

/** The limit of a cache. A lower limit evicts entries, so it asks before applying */
export const LunaCacheLimit = React.memo(({ cache, stats }: LunaCacheLimitProps) => {
	const confirm = useConfirm();
	// Large caches (audio) are set in GB, the rest in MB
	const [unit, unitBytes] = (stats?.bytesLimit ?? 0) >= 8 * GB ? ["GB", GB] : ["MB", MB];

	// Applied when typing stops (Enter, leaving the field, or a pause), not per keystroke: typing "100" would otherwise first set 1
	const [draft, setDraft] = React.useState<number>();
	const pending = React.useRef<number>(undefined);
	const applyTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
	/** `canConfirm` false (leaving the page) drops a limit that would evict entries instead of asking */
	const applyLimit = React.useCallback(
		async (canConfirm = true) => {
			clearTimeout(applyTimer.current);
			const amount = pending.current;
			if (amount === undefined) return;
			pending.current = undefined;
			try {
				const bytes = amount > 0 ? amount * unitBytes : undefined;
				// A limit below what is held evicts the least recently and frequently used entries
				if (stats && bytes !== undefined && bytes < stats.bytes) {
					if (!canConfirm) return;
					const { confirmed } = await confirm({
						title: `Evict cached ${cache.key}?`,
						description: `A ${amount} ${unit} limit is below the ${formatBytes(stats.bytes)} held, the least recently and frequently used are evicted.`,
						confirmationText: "Evict",
					});
					if (!confirmed) return;
				}
				await cache.setUserBytesLimit(bytes);
			} catch (err) {
				trace.msg.err.withContext(`Failed to set the ${cache.key} cache limit`)(err);
			} finally {
				// Shows the applied limit again, or the old one if it was cancelled or failed
				if (pending.current === undefined) setDraft(undefined);
			}
		},
		[cache, confirm, stats, unit, unitBytes],
	);
	// Leaving the page applies what was typed
	React.useEffect(() => () => void applyLimit(false), [applyLimit]);

	// A cache without a default limit has none (Infinity), shown as 0
	const limit = stats && (stats.userBytesLimit ?? stats.bytesLimit);
	return (
		<LunaNumberSetting
			title={`Limit (${unit})`}
			desc={
				stats &&
				`0 for the default${Number.isFinite(stats.maxBytesLimit) ? `, capped at ${formatBytes(stats.maxBytesLimit)}` : ""}. Now ${
					Number.isFinite(stats.bytesLimit) ? formatBytes(stats.bytesLimit) : "no limit"
				}`
			}
			min={0}
			// The unit is known once the stats are
			disabled={stats === undefined}
			value={draft ?? (limit !== undefined && Number.isFinite(limit) ? Math.round(limit / unitBytes) : 0)}
			onNumber={(amount) => {
				setDraft(amount);
				pending.current = amount;
				clearTimeout(applyTimer.current);
				applyTimer.current = setTimeout(applyLimit, 2000);
			}}
			onBlur={() => applyLimit()}
			onKeyDown={(e) => e.key === "Enter" && applyLimit()}
		/>
	);
});
