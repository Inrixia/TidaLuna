/**
 * Installed themes: where they are stored, and what happens to them when the app starts.
 *
 * Kept beside the LunaTheme class rather than inside it: the class knows what a theme is and what it may do, this knows
 * that themes live in Luna's settings store and are resumed once when TIDAL boots.
 */

import { Signal } from "@inrixia/helpers";
import { Messager, ReactiveStore, Tracer } from "@luna/core";
import { whenAppReady } from "@luna/lib";

import { unloads } from "../../index.safe";
import { LunaTheme, type ThemeData } from "./LunaTheme";

const { trace } = Tracer("[@luna/ui]", null);

const lunaStorage = ReactiveStore.getStore("@luna/storage");

/** Installed themes, by url. The css is kept so a restart restyles the page without a request. */
export const themes = await lunaStorage.getReactive<Record<string, ThemeData>>("themes", {});

/**
 * What the last startup changed, kept after the toast is gone.
 *
 * TIDAL's toasts last about four seconds and there is no duration in the payload to lengthen, so a toast alone loses the
 * information: by the time the app has finished loading and you look at it, it is already dismissing. The tab shows this
 * instead, until it is dismissed.
 */
export const startupNotice = new Signal<string | undefined>(undefined);

// Take over every stored theme: the stored css goes on the page at once, and a theme that never finished downloading is
// fetched. An entry that should never have been written is reported and left alone, rather than dropped along with the css
// it still holds.
LunaTheme.loadFromStore(themes, unloads, (url, error) => trace.err.withContext(`Not applying ${url}`)(error));

// Then revalidate them once, in the background: the page is already styled, so only the themes that changed upstream are
// restyled. Without this a theme stayed stale until it was refreshed by hand and then disabled and re-enabled, which hurt
// themes shipped as several packages (a base, a second part, fonts, addons) once per package.
LunaTheme.refreshAll()
	.then((summary) => {
		// Say it happened: the css is swapped in while TIDAL is starting, so colours and spacing change with nothing on screen
		// to explain why. Named from the row's own manifest, so the toast and the tab call a theme the same thing, and said
		// once the interface is up rather than over an empty window
		if (summary.updated.length > 0) {
			const names = summary.updated.map((theme) => theme.manifest.name);
			const listed = names.slice(0, 3).join(", ");
			const rest = names.length - 3;
			const which = rest > 0 ? `${listed} and ${rest} more` : listed;
			const message = names.length === 1 ? `Theme updated at startup: ${which}` : `${names.length} themes updated at startup: ${which}`;
			startupNotice._ = message;
			whenAppReady(unloads)
				.then((ready) => {
					if (ready) Messager.Info(message);
				})
				.catch(trace.err.withContext("Could not report the themes updated at startup"));
		}
		if (summary.failed.length > 0) trace.err(`${summary.failed.length} theme(s) could not be checked at startup`);
	})
	.catch(trace.err.withContext("Startup theme refresh failed"));

// Emergency shortcut to disable all themes (Ctrl+Shift+T), for a theme that made the page unusable
const onEmergencyDisable = (event: KeyboardEvent) => {
	if (!(event.ctrlKey && event.shiftKey && event.key === "T")) return;
	let disabled = 0;
	for (const theme of LunaTheme.all()) {
		if (!theme.data.enabled) continue;
		theme.disable();
		disabled++;
	}
	if (disabled > 0) trace.log(`Emergency disable: disabled ${disabled} theme(s)`);
};
document.addEventListener("keydown", onEmergencyDisable);
unloads.add(() => document.removeEventListener("keydown", onEmergencyDisable));
