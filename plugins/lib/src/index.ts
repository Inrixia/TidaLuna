export * from "./index.safe";

export * from "./classes";
export * from "./helpers";

export * as ipcRenderer from "./ipc";
export * as redux from "./redux";

import { Playlist, Shortcut, StyleTag } from "./classes";
import { observePromise } from "./helpers/observable";

import { unloads } from "./index.safe";

observePromise(unloads, "div[class^='_mainContainer'] > div[class^='_bar'] > div[class^='_title']", 30000).then((title) => {
	if (title !== null) title.innerHTML = 'TIDA<b><span style="color: #32f4ff;">Luna</span></b>	<span style="color: red;">BETA</span>';
});

export { errSignal } from "./index.safe";

// Hide the update notification on MacOS as it breaks Luna for some reason
new StyleTag("MacOS-update-fix", unloads, `div div div[data-test="notification-update"]:first-of-type { display: none; }`);

// Delete removes the selected tracks from the open playlist, if it is the user's own (luna-plugins#148)
Shortcut.register(unloads, {
	id: "removeFromPlaylist",
	keys: "Delete",
	label: "Remove selected tracks from playlist",
	action: () => Playlist.removeSelected(),
});
