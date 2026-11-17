import { ContextMenu, redux } from "@luna/lib";

import { confirm } from "./helpers/confirm";
import { unloads } from "./index.safe";

// "Luna Settings" sits right above "Log out" in the profile menu, so a slip logs people out (#58).
// Ask before a logout that came from that menu. Logouts TIDAL starts on its own (expired session
// etc.) are not touched: only a session/LOGOUT shortly after a click inside the profile menu is.

const MENU_CLICK_WINDOW_MS = 1500;

let menuClickAt = 0;
let confirming = false;
let replaying = false;

ContextMenu.onOpen(unloads, ({ event, contextMenu }) => {
	if (event.type !== "USER_PROFILE") return;
	// Any item works and needs no label matching, so it does not depend on TIDAL's UI language
	// pointerdown as well as click: TIDAL may act on the press before the click event fires
	const mark = () => (menuClickAt = Date.now());
	contextMenu.addEventListener("pointerdown", mark, { capture: true });
	contextMenu.addEventListener("click", mark, { capture: true });
});

redux.intercept("session/LOGOUT", unloads, (payload) => {
	if (replaying) return;
	// A second logout while the dialog is open is the same request
	if (confirming) return true;
	if (Date.now() - menuClickAt > MENU_CLICK_WINDOW_MS) return;
	menuClickAt = 0;
	confirming = true;

	// TIDAL's logout saga reads initiatedByUser from the action argument, so replay it as received
	const args = typeof payload === "object" && payload !== null ? payload : { initiatedByUser: true };

	confirm({
		title: "Log out of TIDAL?",
		description: "You will need to sign in again.",
		confirmationText: "Log out",
		cancellationText: "Cancel",
	})
		.then(({ confirmed }) => {
			if (!confirmed) return;
			replaying = true;
			try {
				(redux.actions["session/LOGOUT"] as unknown as (args: unknown) => unknown)(args);
			} finally {
				queueMicrotask(() => (replaying = false));
			}
		})
		.catch((err) => console.error("[@luna/ui] Logout confirmation failed", err))
		.finally(() => (confirming = false));

	// Cancel this dispatch, the confirmed path above replays it
	return true;
});
