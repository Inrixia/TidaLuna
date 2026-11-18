import { LunaPlugin } from "@luna/core";

/**
 * Wrap the onError handler of an event emitter so a listener's error is attributed to the plugin it came from.
 *
 * registerEmitter hands the same onError to every listener and doesn't say which one threw, so a broken listener in
 * a plugin was logged against the module that owns the emitter (e.g. @luna/lib). The error's stack still names the
 * plugin's bundle: if it does, the error is logged with the plugin's name and shown on its card, otherwise `fallback` runs.
 */
export const listenerError =
	(context: string, fallback: (err: unknown) => unknown) =>
	(err: unknown): void => {
		const culprit = LunaPlugin.fromStack((<Error>err)?.stack);
		if (culprit === undefined) {
			fallback(err);
			return;
		}
		console.error(`[${culprit.name}] Listener error in ${context}:`, err);
		culprit.reportError(`${context}: ${(<Error>err)?.message ?? String(err)}`);
	};
