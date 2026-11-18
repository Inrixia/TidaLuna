export * from "./index.safe";

export * from "./classes";
export * from "./helpers";

export * as ipcRenderer from "./ipc";
export * as redux from "./redux";

import { StyleTag } from "./classes";

import { unloads } from "./index.safe";

// TIDAL re-renders the title bar (e.g. after logout/login), so set the title on every new title node.
// Each node is checked once and only TIDAL's untouched title (plain "TIDAL" text, no elements) is replaced,
// so anything a plugin has changed in it is never overwritten. A mutation batch normally costs one isConnected check.
// Plugins that want to keep TIDAL's own title can set the `data-luna-title-off` attribute on <html>.
const titleSelector = "div[class^='_mainContainer'] > div[class^='_bar'] > div[class^='_title']";
let title: Element | null = null;
const ensureTitle = () => {
	if (title?.isConnected === true) return;
	title = document.querySelector(titleSelector);
	if (document.documentElement.hasAttribute("data-luna-title-off")) return;
	if (title?.childElementCount === 0 && title.textContent === "TIDAL")
		title.innerHTML = 'TIDA<b data-luna-title><span style="color: #32f4ff;">Luna</span></b>	<span style="color: red;">BETA</span>';
};
const titleObserver = new MutationObserver(ensureTitle);
titleObserver.observe(document.body, { childList: true, subtree: true });
unloads.add(titleObserver.disconnect.bind(titleObserver));
ensureTitle();

export { errSignal } from "./index.safe";

// Hide the update notification on MacOS as it breaks Luna for some reason
new StyleTag("MacOS-update-fix", unloads, `div div div[data-test="notification-update"]:first-of-type { display: none; }`);
