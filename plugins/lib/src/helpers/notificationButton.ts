import { unloads } from "../index.safe";
import { observe } from "./observable";

const notificationSelector = `[data-test="notification"]`;

/**
 * Add a button next to the close button of the next TIDAL notification that shows `message`, as TIDAL's notifications
 * can't have their own buttons. Call it right before the notification is shown, e.g. before `trace.msg.log(message)`.
 * Clicking the button closes the notification and calls `onClick`.
 * @param timeoutMs Give up if no such notification appears within this time
 */
export const addNotificationButton = (message: string, label: string, onClick: () => unknown, timeoutMs: number = 2000) => {
	// Notifications already showing, so an older one with the same message isn't picked
	const shown = new Set(document.querySelectorAll(notificationSelector));
	const stop = observe(unloads, notificationSelector, (notification) => {
		if (shown.has(notification) || !notification.textContent?.includes(message)) return;
		const close = notification.querySelector<HTMLButtonElement>(`[data-test="notification-close"]`);
		if (close === null) return;
		done();
		const button = <HTMLButtonElement>close.cloneNode();
		button.removeAttribute("data-test");
		button.textContent = label;
		button.addEventListener("click", () => {
			close.click();
			onClick();
		});
		close.before(button);
	});
	// Also take the observer's unload back out of lib's unloads, it would keep `onClick` alive until Luna unloads
	const done = () => {
		stop();
		unloads.delete(stop);
		clearTimeout(timeout);
	};
	const timeout = setTimeout(done, timeoutMs);
};
