import type { LunaUnload, LunaUnloads } from "@luna/core";

import clientHeaderBase64 from "file://../../../assets/brand/client-header.svg?base64";
import { observe } from "./helpers/observable";
import { unloads } from "./index.safe";

/**
 * What TIDAL's title bar is given instead of TIDAL's own wordmark: the brand lockup, wordmark and BETA pill, so the bar
 * matches the boot splash and the settings header. Inlined at build time, there is no file to ship alongside the plugin.
 */
const lunaTitle = `<img src="data:image/svg+xml;base64,${clientHeaderBase64}" alt="TidaLuna" style="height: 26px; width: auto; vertical-align: middle;" />`;

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
