import React from "react";

import { requestCache } from "@luna/core";
import { AudioCache, type AudioCacheStats } from "@luna/lib";

import Typography from "@mui/material/Typography";

import { LunaButtonSetting, LunaNumberSetting, LunaSettings } from "../../components";

const GB = 1024 ** 3;
const formatBytes = (bytes: number) => (bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

export const LunaCacheSettings = React.memo(() => {
	const [audio, setAudio] = React.useState<AudioCacheStats>();
	const [requests, setRequests] = React.useState(requestCache.stats());
	React.useEffect(() => {
		const update = () => {
			AudioCache.stats().then(setAudio);
			setRequests(requestCache.stats());
		};
		update();
		const interval = setInterval(update, 2000);
		return () => clearInterval(interval);
	}, []);

	const limitDesc =
		audio &&
		`Using ${formatBytes(audio.usage)} of ${formatBytes(audio.limit)} in ${audio.files} tracks. 0 for 128 GB, never more than 75% of free disk space`;
	return (
		<LunaSettings title="Cache" desc="Audio of tracks played, hovered and next in the queue, and TIDAL's requests">
			<LunaNumberSetting
				title="Audio cache limit (GB)"
				desc={limitDesc}
				value={audio?.userLimit === undefined ? 0 : Math.round(audio.userLimit / GB)}
				onNumber={(gb) => AudioCache.setLimit(Math.max(0, gb) * GB).then(() => AudioCache.stats().then(setAudio))}
			/>
			<LunaButtonSetting title="Open audio cache folder" desc={audio?.path} onClick={() => AudioCache.openFolder()} children="Open" />
			{audio && (
				<Typography variant="body2" sx={{ paddingLeft: 2 }}>
					Audio: {formatBytes(audio.servedBytes)} played from the cache, {formatBytes(audio.fetchedBytes)} fetched
					{audio.fetching.length !== 0 && `, fetching ${audio.fetching.length} tracks`} this session
				</Typography>
			)}
			<Typography variant="body2" sx={{ paddingLeft: 2 }}>
				Requests: {requests.entries} cached, {requests.served} answered from the cache, {requests.fetched} fetched this session
			</Typography>
		</LunaSettings>
	);
});
