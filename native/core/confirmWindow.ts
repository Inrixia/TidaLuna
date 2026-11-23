// Luna's confirmations (for now the core natives that need the user, see policy.ts), asked by the main process in a
// window of its own. Page code can cover, restyle or remove anything in TIDAL's page, so a prompt drawn there can be
// clickjacked; this window is a separate webContents (own session, no preload) that nothing in the page can see, cover or
// click. Built like the native permission window (NativeModule/permissions/window.ts), and shares its queue.
import { BrowserWindow, ipcMain } from "electron";

import { createPromptWindow, inPromptQueue, visibleOwner } from "../NativeModule/permissions/promptWindow";
import { ARM_DELAY_MS, buildConfirmHtml, confirmGate, confirmRequest, SUBMIT, TITLE, USER_INPUT_MS, type ConfirmRequest } from "./confirmPage";
import { notAsked } from "./notAsked";

// Page code can ask for confirmations: it must not flood the user with windows
const gate = confirmGate();
/** TIDAL windows whose blur ends the user's last answer counting as use (see confirmGate) */
const watched = new WeakSet<BrowserWindow>();

/**
 * Asks the user. `answer` is true only if they clicked the confirm button; closing the window is a cancel.
 * `refused` says why no window opened: TIDAL is not in use (the request came from page code), too many are waiting, or
 * the last ones were all cancelled (see confirmGate).
 *
 * @param recentUserInput See TidalState
 */
export const askConfirm = async (
	request: ConfirmRequest,
	parent: BrowserWindow | undefined,
	recentUserInput: boolean,
): Promise<{ answer: boolean; refused?: string }> => {
	const owner = visibleOwner(parent);
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
		answer = await inPromptQueue(() => show(request, parent));
		return { answer: answer === true };
	} finally {
		gate.answered(answer, Date.now());
	}
};

/** Resolves with the user's answer, or undefined if no window could be shown */
const show = (request: ConfirmRequest, parent?: BrowserWindow) =>
	new Promise<boolean | undefined>((resolve) => {
		// TIDAL may have been hidden while earlier prompts were answered
		const owner = visibleOwner(parent);
		if (owner === undefined) return resolve(undefined);
		const win = createPromptWindow({
			parent: owner,
			modal: true,
			width: 560,
			height: 200,
			useContentSize: true,
			resizable: false,
			title: TITLE,
			partition: "luna-confirm",
		});
		let answer: boolean | undefined;
		win.on("page-title-updated", (event, title) => {
			if (!title.startsWith(SUBMIT)) return;
			event.preventDefault();
			answer = title === `${SUBMIT}yes`;
			win.close();
		});
		// Shown: closing it from here on is the user's cancel
		win.once("show", () => (answer ??= false));
		win.once("ready-to-show", async () => {
			const height = await win.webContents.executeJavaScript("document.body.scrollHeight").catch(() => undefined);
			if (win.isDestroyed()) return;
			if (typeof height === "number" && Number.isFinite(height)) win.setContentSize(560, Math.min(Math.max(Math.ceil(height), 180), 700));
			win.center();
			win.show();
			// A click meant for TIDAL that lands on the new window doesn't confirm
			setTimeout(() => !win.isDestroyed() && void win.webContents.executeJavaScript("window.arm()").catch(() => {}), ARM_DELAY_MS);
		});
		win.once("closed", () => resolve(answer));
		win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildConfirmHtml(request))}`).catch((err) => {
			console.error("[🛑Security🛑] Failed to show the Luna confirmation", err);
			if (!win.isDestroyed()) win.close();
		});
	});

// #region Who asks
/** When the preload last saw a trusted click or key in a renderer: webContents id -> Date.now() */
const lastInput = new Map<number, number>();
// Sent by the preload (native/preload.ts), which sees only trusted events. It only lets a window open: the click in it is still the user's
ipcMain.on("__Luna.userInput", (event, active: unknown) => {
	const { sender } = event;
	if (active !== true) return lastInput.delete(sender.id);
	if (!lastInput.has(sender.id)) sender.once("destroyed", () => lastInput.delete(sender.id));
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
