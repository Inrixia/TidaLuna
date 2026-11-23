import React from "react";

import { audioCache, offlineCache, type AudioCacheExtra } from "@luna/lib";
import { requestCache, unloadSet, type LunaUnloads } from "@luna/core";

import Typography from "@mui/material/Typography";

import { formatBytes, LunaCacheSetting, LunaSettings } from "../../components";

export const LunaCacheSettings = React.memo(() => {
	const [requests, setRequests] = React.useState(requestCache.stats());
	React.useEffect(() => {
		const unloads: LunaUnloads = new Set();
		requestCache.onStats(unloads, setRequests);
		return () => void unloadSet(unloads);
	}, []);

	return (
		<LunaSettings title="Cache" desc="Audio of tracks played, hovered and next in the queue, and TIDAL's requests">
			<LunaCacheSetting
				cache={audioCache}
				title="Audio"
				desc="Never more than 75% of free disk space."
				entries="tracks"
				details={({ extra }) => (
					<Typography variant="body2" sx={{ paddingLeft: 2 }}>
						Audio: {formatBytes((extra as AudioCacheExtra).servedBytes)} played from the cache, {formatBytes((extra as AudioCacheExtra).fetchedBytes)}{" "}
						fetched
						{(extra as AudioCacheExtra).fetching.length !== 0 && `, fetching ${(extra as AudioCacheExtra).fetching.length} tracks`} this session
					</Typography>
				)}
			/>
			<LunaCacheSetting cache={offlineCache} title="Offline" desc="Pages and images kept for offline use." entries="responses" />
			<Typography variant="body2" sx={{ paddingLeft: 2 }}>
				Requests: {requests.entries} cached, {requests.served} answered from the cache, {requests.fetched} fetched this session
			</Typography>
		</LunaSettings>
	);
});
