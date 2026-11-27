// Luna's confirmations (for now the core natives that need the user, see policy.ts), asked by the main process in a
// NativeConfirm window, like the native permission window: TIDAL's page can't see, cover or click it.
import { BrowserWindow, ipcMain } from "electron";

import { NativeConfirm } from "../NativeConfirm/NativeConfirm";
import { buildConfirmHtml, confirmGate, confirmRequest, USER_INPUT_MS, type ConfirmRequest } from "./confirmPage";
import { notAsked } from "./notAsked";

const confirmWindow = new NativeConfirm<"yes" | "no">({
	partition: "luna-confirm",
	title: "Luna",
	width: 560,
	minHeight: 180,
	maxHeight: 700,
	showUnowned: false,
});

// Page code can ask for confirmations: it must not flood the user with windows
const gate = confirmGate();
/** TIDAL windows whose blur ends the user's last answer counting as use (see confirmGate) */
const watched = new WeakSet<BrowserWindow>();

/**
 * Asks the user. `answer` is true only if they clicked the confirm button; closing the window is a cancel.
 * `refused` says why no window opened: TIDAL is not in use (the request came from page code), too many are waiting, or
 * the last ones were all cancelled (see confirmGate), or TIDAL was hidden before its turn came.
 *
 * @param recentUserInput See TidalState
 */
const askConfirm = async (
	request: ConfirmRequest,
	parent: BrowserWindow | undefined,
	recentUserInput: boolean,
): Promise<{ answer: boolean; refused?: string }> => {
	const owner = NativeConfirm.visibleOwner(parent);
	if (owner !== undefined && !watched.has(owner)) {
		watched.add(owner);
		// Our own window taking the focus comes before the answer; going to another app after it ends it
		owner.on("blur", () => gate.left());
	}
	const refused = gate.refuse({
		tidal: { visible: owner !== undefined, focused: owner?.isFocused() === true, recentUserInput },
		now: Date.now(),
	});
	if (refused !== undefined) {
		console.warn(`[🛑Security🛑] Did not ask "${request.title}": ${refused}`);
		return { answer: false, refused };
	}
	let answer: boolean | undefined;
	try {
		const asked = await confirmWindow.ask(parent, () => ({ html: buildConfirmHtml(request), answers: ["yes", "no"] }));
		// Not the user's cancel: TIDAL was hidden or the window failed before it showed
		if (!asked?.shown) return { answer: false, refused: "its window could not be shown over TIDAL" };
		// Closing the window is a cancel
		answer = asked.answer === "yes";
		return { answer };
	} finally {
		gate.answered(answer, Date.now());
	}
};

// #region Who asks
/** When the preload last saw a trusted click or key in a renderer: webContents id -> Date.now() */
const lastInput = new Map<number, number>();
/** Renderers whose lastInput entry is already removed when they are destroyed (one listener each, however often they leave) */
const cleanedUp = new WeakSet<Electron.WebContents>();
// Sent by the preload (native/preload.ts), which sees only trusted events. It only lets a window open: the click in it is still the user's
ipcMain.on("__Luna.userInput", (event, active: unknown) => {
	const { sender } = event;
	if (active !== true) return lastInput.delete(sender.id);
	if (!cleanedUp.has(sender)) {
		cleanedUp.add(sender);
		sender.once("destroyed", () => lastInput.delete(sender.id));
	}
	lastInput.set(sender.id, Date.now());
});

/**
 * Asks the user of the renderer that sent `event`, in a window over it. Whether they used TIDAL just before is taken
 * now, when the request arrives: work before the question can take a while. Throws (notAsked) when the gate refused, so
 * the user learns why nothing opened.
 */
export const askerFor = (sender: Electron.WebContents) => {
	const parent = BrowserWindow.fromWebContents(sender) ?? undefined;
	const recentUserInput = Date.now() - (lastInput.get(sender.id) ?? -Infinity) < USER_INPUT_MS;
	return async ({ title, lines, confirmText }: ConfirmRequest): Promise<boolean> => {
		const request = confirmRequest(title, lines, confirmText);
		const { answer, refused } = await askConfirm(request, parent, recentUserInput);
		if (refused === undefined) return answer;
		throw notAsked(request.title, refused);
	};
};
// #endregion
