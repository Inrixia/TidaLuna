// A request Luna did not ask the user about (see confirmGate in confirmPage.ts). Errors cross into the
// page through contextBridge with only their message, so the message carries the marker (see notAskedMessage).
const MARKER = " was not asked: ";

/** The error a request throws when main refused to ask */
export const notAsked = (title: string, reason: string) => new Error(`[Luna.core] "${title}"${MARKER}${reason}`);

/** What to tell the user if `err` is a request that was not asked, else undefined */
export const notAskedMessage = (err: unknown): string | undefined => {
	const message = err instanceof Error ? err.message : undefined;
	if (message === undefined) return undefined;
	const start = message.indexOf("[Luna.core] ");
	if (start === -1 || !message.includes(MARKER, start)) return undefined;
	return message.slice(start + "[Luna.core] ".length);
};
