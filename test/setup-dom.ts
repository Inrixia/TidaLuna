// IndexedDB for ReactiveStore. Must be imported before anything opens a store.
import "fake-indexeddb/auto";
// Preload globals (`__ipcRenderer`, `__platform`, `luna`)
import "./setup-node";

import { buildActions } from "../render/src/exposeTidalInternals.patchAction";
import { setIpcHandler } from "./setup-node";

/**
 * TIDAL registers its own redux action builders (`buildActions`) as it boots, and `plugins/lib/src/redux/actions.ts`
 * copies the ones it finds into `actions` *once*, when it is first imported. So the builders a test calls have to
 * exist before that import happens — this file is what runs first.
 */
const seededActionTypes = [
	"content/INVALIDATE_TRACK_LIST",
	"content/LOAD_SINGLE_MEDIA_ITEM",
	"etag/REMOVE_PLAYLIST_ETAG",
	"featureFlags/TOGGLE_USER_OVERRIDE",
	"folders/LOAD_FOLDER_ITEMS",
	"message/MESSAGE_ERROR",
	"message/MESSAGE_INFO",
	"message/MESSAGE_WARN",
	"playQueue/ADD_NEXT",
	"playQueue/DISABLE_SHUFFLE_MODE",
	"playQueue/DISABLE_SHUFFLE_MODE_AND_UNSHUFFLE_ITEMS",
	"playQueue/ENABLE_SHUFFLE_MODE",
	"playQueue/ENABLE_SHUFFLE_MODE_AND_SHUFFLE_ITEMS",
	"playQueue/MOVE_NEXT",
	"playQueue/MOVE_PREVIOUS",
	"playQueue/MOVE_TO",
	"playQueue/RESET",
	"playQueue/SET_REPEAT_MODE",
	"playbackControls/DECREASE_VOLUME",
	"playbackControls/INCREASE_VOLUME",
	"playbackControls/PAUSE",
	"playbackControls/PLAY",
	"playbackControls/SEEK",
	"playbackControls/SET_PLAYBACK_STATE",
	"player/PRELOAD_NEXT_ITEM",
	"router/PUSH",
	"session/LOGOUT",
	"tidalOpenPlatformApi/invalidateTags",
];

for (const type of seededActionTypes) {
	buildActions[type] ??= (payload?: unknown) => ({ type, payload });
}

// `applySeedSettings` reads luna-settings.json over this channel; unset means "no seed file"
setIpcHandler("__Luna.getSeedSettings", () => null);

// happy-dom doesn't implement the Media Session API, which ImageOverrides.ts reads at import
(globalThis as any).MediaSession ??= class {
	public metadata: unknown;
	public playbackState = "none";
	public setActionHandler() {}
	public setPositionState() {}
};
