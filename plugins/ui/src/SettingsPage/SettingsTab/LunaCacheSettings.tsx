import React from "react";
import { store as obyStore } from "oby";

import { Cache } from "@luna/core";
import { AudioStreams } from "@luna/lib";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";

import { LunaCacheSetting, LunaNumberSetting, LunaSettings } from "../../components";

const nativePrefix = "native:";

/** The main process caches (audio, offline) first, they hold the most */
const listCaches = () =>
	[...Cache.controls.values()].sort((a, b) => Number(b.key.startsWith(nativePrefix)) - Number(a.key.startsWith(nativePrefix)));

const AudioWindow = React.memo(() => {
	const [ahead, setAhead] = React.useState(AudioStreams.settings.ahead);
	const [behind, setBehind] = React.useState(AudioStreams.settings.behind);
	React.useEffect(
		() =>
			obyStore.on(AudioStreams.settings, () => {
				setAhead(AudioStreams.settings.ahead);
				setBehind(AudioStreams.settings.behind);
			}),
		[],
	);
	return (
		<Stack spacing={1}>
			<LunaNumberSetting
				title="Tracks ahead"
				desc="Upcoming queue tracks to prefetch and cache in the background"
				min={0}
				max={20}
				value={ahead}
				onNumber={(value) => {
					AudioStreams.settings.ahead = value;
					AudioStreams.updateWindowSoon();
				}}
			/>
			<LunaNumberSetting
				title="Tracks behind"
				desc="Previous queue tracks to keep prefetched and cached"
				min={0}
				max={20}
				value={behind}
				onNumber={(value) => {
					AudioStreams.settings.behind = value;
					AudioStreams.updateWindowSoon();
				}}
			/>
		</Stack>
	);
});

export const LunaCacheSettings = React.memo(() => {
	// Main process caches are added once their proxies are, plugins add caches too
	const [caches, setCaches] = React.useState(listCaches);
	React.useEffect(() => {
		const stop = Cache.onControlAdded(new Set(), () => setCaches(listCaches()));
		// One added between the first render and this effect
		setCaches(listCaches());
		return stop;
	}, []);

	return (
		<LunaSettings title="Cache" desc="What Luna keeps so TIDAL loads, plays and works offline without fetching it again">
			<Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))", gap: 2, paddingBottom: 1 }}>
				{caches.map((cache) => (
					<LunaCacheSetting key={cache.key} cache={cache}>
						{cache.key === "native:audio" && <AudioWindow />}
					</LunaCacheSetting>
				))}
			</Box>
		</LunaSettings>
	);
});
