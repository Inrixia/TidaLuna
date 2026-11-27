import type { LunaUnloads } from "@luna/core";

import { libTrace } from "../index.safe";
import { observePromise } from "./observable";

const { trace } = libTrace.withSource(".appReady");

/** TIDAL's own shell: the sidebar and the page it holds. The sidebar alone appears while the page is still an outline. */
const shellSelector = 'nav, [class*="sidebar"]';
/** The page content itself */
const contentSelector = "main";

/** The one answer to "is TIDAL up yet", so everything that waits for it waits for the same thing */
let appReady: Promise<boolean> | undefined;

/**
 * Resolve once TIDAL has painted its own interface, or when the cap expires.
 *
 * A toast shown before the shell exists lands on an empty window and is gone before the content paints, so what waits for
 * the interface waits for the sidebar *and* the page inside it. Waiting on the observer rather than a timer is what makes
 * this an event: the interface arriving is the thing being waited for.
 *
 * The cap keeps a page that never paints (a failed load, an update midway) from swallowing whatever is waiting, and it
 * says so through the tracer: a silent cap is a bug nobody can report.
 *
 * Answers once. Later callers get the same answer immediately, and a page reload starts a new one.
 *
 * @param unloads Stops the observation when the plugin unloads
 * @param maxMs How long to wait before giving up on the interface
 * @returns Whether the interface was up before the cap expired
 */
export const whenAppReady = (unloads: LunaUnloads, maxMs = 8000): Promise<boolean> =>
	(appReady ??= (async () => {
		if ((await observePromise(unloads, shellSelector, maxMs)) === null) return notReady(maxMs, "its sidebar");
		if ((await observePromise(unloads, contentSelector, maxMs)) === null) return notReady(maxMs, "its page content");
		return true;
	})());

/** Say that the wait ran out, naming what never arrived, so a page that does not paint is reported rather than tolerated */
const notReady = (maxMs: number, what: string): false => {
	trace.msg.warn(`TIDAL did not paint ${what} within ${maxMs}ms, continuing without waiting for it`);
	return false;
};
