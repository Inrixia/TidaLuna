import React from "react";

import { requestCache, Tracer } from "@luna/core";
import { AudioCache, type AudioCacheStats } from "@luna/lib";

import Typography from "@mui/material/Typography";
import { useConfirm } from "material-ui-confirm";

import { LunaButtonSetting, LunaNumberSetting, LunaSettings } from "../../components";

const { trace } = Tracer("[@luna/ui]", null);

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

	// A lower limit deletes tracks at once, so it is applied when typing stops (Enter, leaving the field, or a pause), not per keystroke:
	// typing "100" would otherwise first set 1 GB
	const [draftGb, setDraftGb] = React.useState<number>();
	const pendingGb = React.useRef<number>(undefined);
	const applyTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
	const confirm = useConfirm();
	/** `canConfirm` false (leaving the page) drops a limit that would delete tracks instead of asking */
	const applyLimit = React.useCallback(async (canConfirm = true) => {
		clearTimeout(applyTimer.current);
		const gb = pendingGb.current;
		if (gb === undefined) return;
		pendingGb.current = undefined;
		try {
			const bytes = Math.max(0, gb) * GB;
			const { usage } = await AudioCache.stats();
			if ((bytes || 128 * GB) < usage) {
				if (!canConfirm) return;
				const { confirmed } = await confirm({
					title: "Delete cached tracks?",
					description: `The cache uses ${formatBytes(usage)}. A ${gb || 128} GB limit deletes the least recently played tracks until it fits.`,
					confirmationText: "Delete tracks",
				});
				if (!confirmed) return;
			}
			await AudioCache.setLimit(bytes);
			setAudio(await AudioCache.stats());
		} catch (err) {
			trace.msg.err.withContext("Failed to set the audio cache limit")(err);
		} finally {
			// Shows the applied limit again, or the old one if it was cancelled or failed
			if (pendingGb.current === undefined) setDraftGb(undefined);
		}
	}, []);
	// Leaving the page applies what was typed
	React.useEffect(() => () => void applyLimit(false), []);

	const limitDesc =
		audio &&
		`Using ${formatBytes(audio.usage)} of ${formatBytes(audio.limit)} in ${audio.files} tracks. 0 for 128 GB, never more than 75% of free disk space`;
	return (
		<LunaSettings title="Cache" desc="Audio of tracks played, hovered and next in the queue, and TIDAL's requests">
			<LunaNumberSetting
				title="Audio cache limit (GB)"
				desc={limitDesc}
				min={0}
				value={draftGb ?? (audio === undefined ? 0 : Math.round((audio.userLimit ?? 128 * GB) / GB))}
				onNumber={(gb) => {
					setDraftGb(gb);
					pendingGb.current = gb;
					clearTimeout(applyTimer.current);
					applyTimer.current = setTimeout(applyLimit, 2000);
				}}
				onBlur={() => applyLimit()}
				onKeyDown={(e) => e.key === "Enter" && applyLimit()}
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
