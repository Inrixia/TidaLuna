import { safeTimeout } from "./helpers/safeTimeout";
import { unloads } from "./index.safe";
import * as redux from "./redux";

// TIDAL preloads the next item 15s before the current one ends, so skipping earlier first waits ~300ms on its playbackinfo.
// Preload it once the current item has had a few seconds to start, a skip to it then loads it straight away.
// TIDAL only plays the preloaded item if it is still the item being loaded, otherwise it loads as usual.
let cancelPreload: (() => void) | undefined;
redux.intercept("playbackControls/MEDIA_PRODUCT_TRANSITION", unloads, () => {
	cancelPreload?.();
	cancelPreload = safeTimeout(unloads, () => redux.actions["player/PRELOAD_NEXT_ITEM"](undefined), 5000);
});
