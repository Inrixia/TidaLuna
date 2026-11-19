import { observe } from "./helpers/observable";
import { unloads } from "./index.safe";

// TIDAL re-renders the title bar (e.g. after logout/login), so set the title on every new title node.
// Only TIDAL's untouched title (plain "TIDAL" text, no elements) is replaced, so anything a plugin has changed in it is never overwritten.
// Plugins that want to keep TIDAL's own title can set the `data-luna-title-off` attribute on <html>.
observe(unloads, "div[class^='_mainContainer'] > div[class^='_bar'] > div[class^='_title']", (title) => {
	if (document.documentElement.hasAttribute("data-luna-title-off")) return;
	if (title.childElementCount === 0 && title.textContent === "TIDAL")
		title.innerHTML = 'TIDA<b data-luna-title><span style="color: #32f4ff;">Luna</span></b>	<span style="color: red;">BETA</span>';
});
