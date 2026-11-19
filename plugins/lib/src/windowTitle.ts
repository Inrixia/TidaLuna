import type { LunaUnload, LunaUnloads } from "@luna/core";

import { observe } from "./helpers/observable";
import { unloads } from "./index.safe";

const lunaTitle = 'TIDA<b><span style="color: #32f4ff;">Luna</span></b>	<span style="color: red;">BETA</span>';

let titleElem: Element | undefined;
// TIDAL re-renders the title bar (e.g. after logout/login), so set the Luna title on every new title node
observe(unloads, "div[class^='_mainContainer'] > div[class^='_bar'] > div[class^='_title']", (title) => {
	titleElem = title;
	title.innerHTML = lunaTitle;
});

/**
 * Sets the window title (HTML) shown in the title bar. It is not kept when TIDAL re-renders the title bar.
 * @returns An unload, also added to `unloads`, that puts the Luna title back.
 */
export const setWindowTitle = (unloads: LunaUnloads, html: string): LunaUnload => {
	if (titleElem?.isConnected) titleElem.innerHTML = html;
	const unload = () => {
		unloads.delete(unload);
		if (titleElem?.isConnected) titleElem.innerHTML = lunaTitle;
	};
	unloads.add(unload);
	return unload;
};
