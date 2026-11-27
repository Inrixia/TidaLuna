import type { LunaUnloads } from "@luna/core";

/** The one answer to "is TIDAL up yet", so everything that waits for it waits for the same thing */
let appReady: Promise<void> | undefined;

/** Whether TIDAL's own interface has content in it, rather than being an empty outline */
const painted = (): boolean => {
	const hasShell = document.querySelector('nav, [class*="sidebar"]') !== null;
	const hasContent = (document.querySelector("main")?.innerText ?? "").trim().length > 200;
	return hasShell && hasContent;
};

/**
 * Resolve once TIDAL has painted its own interface, or after a cap.
 *
 * TIDAL's shell is the sidebar plus real page content: the sidebar alone appears while the page is still a blank outline,
 * and a toast shown then lands on an empty window and is gone before the content paints. The cap matters too, because if
 * the shell never appears (a failed load, an update) whatever is waiting would otherwise be swallowed entirely.
 *
 * Resolves once: anything that asks after TIDAL is up is told so at once, and a page reload simply starts a new answer.
 */
export const whenAppReady = (unloads: LunaUnloads, maxMs = 8000): Promise<void> =>
	(appReady ??= new Promise<void>((resolve) => {
		if (painted()) return resolve();
		// Watching the page rather than asking it on a timer: the content arriving is the event being waited for
		const observer = new MutationObserver(() => {
			if (!painted()) return;
			stop();
			resolve();
		});
		const cap = setTimeout(() => {
			stop();
			resolve();
		}, maxMs);
		const stop = () => {
			observer.disconnect();
			clearTimeout(cap);
		};
		observer.observe(document.body, { subtree: true, childList: true, characterData: true });
		unloads.add(stop);
	}));
