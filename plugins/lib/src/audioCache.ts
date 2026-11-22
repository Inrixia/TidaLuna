import { audioCacheWindow } from "./audioCache.native";
import { MediaItem } from "./classes/MediaItem";
import { PlayState } from "./classes/PlayState";
import { safeTimeout } from "./helpers/safeTimeout";
import { libTrace, unloads } from "./index.safe";
import * as redux from "./redux";

// Keeps the audio of the previous, current and next track in memory (and every track played on disk), see native/audioCache.ts.
// Only tracks TIDAL plays through its native player (BTS manifests, the player fetches the file from the url). DASH tracks play in the page and aren't cached.
// TIDAL's own playbackinfo request still runs on a skip: TIDAL rejects a response not made for the streaming session id it sends, so it can't be prefetched.
const audioUrl = async (queueIndex: number) => {
	const { elements } = PlayState.playQueue;
	const item = await MediaItem.fromId(elements[queueIndex]?.mediaItemId);
	if (item?.contentType !== "track") return;
	const playbackInfo = await item.playbackInfo(redux.store.getState().settings.quality.streaming);
	if (playbackInfo?.manifestMimeType === "application/vnd.tidal.bts") return playbackInfo.manifest.urls[0];
};

const updateWindow = async () => {
	const { currentIndex } = PlayState.playQueue;
	const urls = await Promise.all([currentIndex, currentIndex + 1, currentIndex - 1].map(audioUrl));
	await audioCacheWindow(urls.filter((url) => url !== undefined));
};

let cancelUpdate: (() => void) | undefined;
// Debounced, skipping through tracks shouldn't look up each one
redux.intercept("playbackControls/MEDIA_PRODUCT_TRANSITION", unloads, () => {
	cancelUpdate?.();
	cancelUpdate = safeTimeout(unloads, () => updateWindow().catch(libTrace.err.withContext("audioCache")), 1000);
});
