export * from "./index.safe";

export * from "./classes";
export * from "./helpers";

export * as ipcRenderer from "./ipc";
export * as redux from "./redux";

import { StyleTag } from "./classes";

import { unloads } from "./index.safe";

export { setWindowTitle } from "./windowTitle";

import "./navigation";
import "./audioCache";
import "./preloadNext";

export { errSignal } from "./index.safe";

// Hide the update notification on MacOS as it breaks Luna for some reason
new StyleTag("MacOS-update-fix", unloads, `div div div[data-test="notification-update"]:first-of-type { display: none; }`);

// Artist pages render ~3k nodes, half of them sections below the fold. Skip their style/layout until scrolled near (~35ms less per artist page load)
// 300px is about one carousel section's height, auto remembers the real size once rendered so scroll restore stays put
new StyleTag(
	"artist-sections-content-visibility",
	unloads,
	`[data-test="profile-sections"] ~ * { content-visibility: auto; contain-intrinsic-size: auto 300px; }`,
);
