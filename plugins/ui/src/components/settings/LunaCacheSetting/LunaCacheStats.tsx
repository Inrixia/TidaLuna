import React from "react";

import { formatBytes, type CacheStats, type StoreStats } from "@luna/core";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { formatExtra, hitRate, labelOf, percentOf } from "./formatStats";

const Stat = ({ label, value, tip }: { label: string; value: React.ReactNode; tip: string }) => (
	<Tooltip title={tip} placement="top">
		<Box sx={{ borderRadius: 2, backgroundColor: "rgba(255, 255, 255, 0.04)", paddingX: 1.5, paddingY: 0.75 }}>
			<Typography variant="caption" color="text.secondary" children={label} />
			<Typography variant="body1" sx={{ fontWeight: 500, fontVariantNumeric: "tabular-nums" }} children={value} />
		</Box>
	</Tooltip>
);

const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 1 };

/** One store: a bar of metas then values against its limit, its counters and its backends */
const Tier = ({ name, store }: { name: string; store: StoreStats }) => {
	const limited = Number.isFinite(store.bytesLimit);
	const kinds = [store.meta, store.data];
	return (
		<Box>
			<Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 0.5 }}>
				<Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
					<b>{name}</b> {formatBytes(store.metaBytes + store.dataBytes)}
					{limited && ` of ${formatBytes(store.bytesLimit)}`}
				</Typography>
				<Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: "tabular-nums" }}>
					{store.entries.toLocaleString()} entries
				</Typography>
			</Stack>
			<Tooltip title={`${formatBytes(store.dataBytes)} values, ${formatBytes(store.metaBytes)} metas`} placement="top">
				<Box sx={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", backgroundColor: "rgba(255, 255, 255, 0.08)" }}>
					<Box sx={{ width: `${percentOf(store.dataBytes, store.bytesLimit)}%`, backgroundColor: "primary.main" }} />
					<Box sx={{ width: `${percentOf(store.metaBytes, store.bytesLimit)}%`, backgroundColor: "secondary.main" }} />
				</Box>
			</Tooltip>
			<Box sx={{ ...grid, marginTop: 1 }}>
				<Stat
					label="Hit rate"
					value={hitRate(store.hits, store.misses)}
					tip={`${store.hits.toLocaleString()} hits, ${store.misses.toLocaleString()} misses`}
				/>
				<Stat label="Evictions" value={store.evictions.toLocaleString()} tip="Entries evicted this session" />
				<Stat label="Read" value={formatBytes(store.readBytes)} tip="Bytes read this session" />
				<Stat label="Written" value={formatBytes(store.writtenBytes)} tip="Bytes of new and replaced values this session" />
			</Box>
			<Typography variant="caption" color="text.secondary" component="div" sx={{ marginTop: 0.5 }}>
				{`Metas: ${store.meta.kind}. Values: ${store.data.kind}`}
				{store.data.location && `, ${store.data.location}`}
				{store.data.freeBytes !== undefined && ` (${formatBytes(store.data.freeBytes)} free)`}
			</Typography>
			{kinds
				.flatMap((backend) => backend.inFlight ?? [])
				.map((stream) => (
					<Typography key={stream.key} variant="caption" color="text.secondary" component="div" sx={{ fontVariantNumeric: "tabular-nums" }}>
						{`Streaming ${stream.key}: ${formatBytes(stream.filledBytes)}${stream.totalBytes ? ` of ${formatBytes(stream.totalBytes)}` : ""}, ${stream.readers} readers`}
					</Typography>
				))}
		</Box>
	);
};

/** How full a cache's tiers are and how they were used this session */
export const LunaCacheStats = React.memo(({ stats }: { stats: CacheStats }) => (
	<Stack spacing={1.5}>
		<Tier name="Memory" store={stats.memory} />
		{stats.persist && <Tier name="Persisted" store={stats.persist} />}
		<Box sx={grid}>
			<Stat label="Revalidations" value={stats.revalidations.toLocaleString()} tip="Background revalidations run this session" />
			{Object.entries(stats.extra ?? {}).map(([key, value]) => (
				<Stat key={key} label={labelOf(key)} value={formatExtra(key, value)} tip={key} />
			))}
		</Box>
	</Stack>
));
