// The rules page code's network goes by (pageNet.ts), apart from the page so node:test can check them
import { hostAllowed } from "../../../native/core/hosts";

/** The page's enforced connect-src allows this url: the page's own origin, Luna's (`https://luna`), or a host entry */
export const pageAllowsUrl = (connect: string[], pageOrigin: string, url: URL) =>
	url.origin === pageOrigin || url.origin === "https://luna" || hostAllowed(connect, url);

/** Why luna.fetch refused, from the error that crossed IPC (net.ts NetRefused), or undefined for a network failure */
export const refusalReason = (err: unknown): string | undefined => {
	const message = String((err as Error)?.message ?? err);
	const at = message.indexOf("luna.fetch refused");
	if (at === -1) return undefined;
	return message
		.slice(at + "luna.fetch refused".length)
		.replace(/^[a-z ]*:\s*/, "")
		.slice(0, 160);
};

/** One toast for a plugin and host every `everyMs`: a plugin polling a blocked host doesn't fill the screen */
export const toastGate = (everyMs = 30_000, max = 200) => {
	const toasted = new Map<string, number>();
	return (who: string, target: string, now = Date.now()) => {
		const key = `${who}\n${target}`;
		if (now - (toasted.get(key) ?? -Infinity) < everyMs) return false;
		toasted.set(key, now);
		if (toasted.size > max) toasted.clear();
		return true;
	};
};
