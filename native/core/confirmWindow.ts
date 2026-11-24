// Luna's confirmations (for now the core natives that need the user, see policy.ts), asked by the main process in a
// NativeConfirm window, like the native permission window: TIDAL's page can't see, cover or click it.
import { BrowserWindow, ipcMain, shell } from "electron";

import { NativeConfirm } from "../NativeConfirm/NativeConfirm";
import {
	actionToRun,
	buildChoiceHtml,
	buildConfirmHtml,
	confirmGate,
	confirmLinks,
	confirmRequest,
	type ConfirmRequest,
	type ConfirmWarning,
	fitConfirmLines,
	fitLines,
	focusedWithin,
	httpLink,
	isHostAnswer,
	isHostDeny,
	limitedWait,
	NOT_IN_USE,
	oneAtATime,
	shownWarning,
	USER_INPUT_MS,
} from "./confirmPage";
import { notAsked } from "./notAsked";

const confirmWindow = new NativeConfirm<string>({
	partition: "luna-confirm",
	title: "Luna",
	width: 560,
	minHeight: 180,
	maxHeight: 700,
	showUnowned: false,
});

// Page code can ask for confirmations: it must not flood the user with windows
const gate = confirmGate();
// Host questions (net.ts) have a gate of their own: hosts a plugin uses come in bursts, and closing a few of them
// mustn't hold back an install or an update
const hostGate = confirmGate();
/** How long a host question waits for TIDAL to be in use (a plugin's request while TIDAL plays in the background) */
export const HOST_WAIT_MS = 5 * 60_000;
/** Host questions that waited for TIDAL ask one at a time once it's back (the gate lets only a few wait at once) */
const afterWait = oneAtATime();
/** Host questions waiting for TIDAL at most: past them a plugin's request is refused at once, as before the wait */
export const MAX_WAITING = 10;
const waitForTidal = limitedWait(MAX_WAITING);
/** TIDAL windows whose blur ends the user's last answer counting as use (see confirmGate) */
const watched = new WeakSet<BrowserWindow>();

/** Watches `owner`: our own window taking the focus comes before the answer; going to another app after it ends it */
const watch = (owner: BrowserWindow | undefined) => {
	if (owner === undefined || watched.has(owner)) return;
	watched.add(owner);
	owner.on("blur", () => (gate.left(), hostGate.left()));
};

/**
 * Asks the user. `answer` is true only if they clicked the confirm button; closing the window is a cancel.
 * `refused` says why no window opened: TIDAL is not in use (the request came from page code), too many are waiting, or
 * the last ones were all cancelled (see confirmGate), or TIDAL was hidden before its turn came.
 * Rejects if the warning's action the user chose failed: what they confirmed was with it done.
 *
 * @param recentUserInput See TidalState
 */
const askConfirm = async (
	request: ConfirmRequest,
	parent: BrowserWindow | undefined,
	recentUserInput: boolean,
): Promise<{ answer: boolean; refused?: string }> => {
	const owner = NativeConfirm.visibleOwner(parent);
	watch(owner);
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
		let warning: ConfirmWarning | undefined;
		// The user chose the warning's action: it runs if they confirm (closing or cancelling drops it)
		let warningChosen = false;
		const asked = await confirmWindow.ask(parent, () => {
			// Taken when the window's turn comes: prompts before it may have changed what it warns about
			warning = shownWarning(request);
			const links = confirmLinks(request);
			return {
				html: buildConfirmHtml({ ...request, warning }),
				answers: ["yes", "no"],
				onNote: (what, run) => {
					const link = what.startsWith("link:") ? httpLink(links[Number(what.slice(5))]) : undefined;
					if (link !== undefined) void shell.openExternal(link).catch(() => {});
					if (what === "action" && warning !== undefined && !warningChosen) {
						warningChosen = true;
						run(`window.warningDone(${JSON.stringify(warning.done)})`);
					}
				},
			};
		});
		// Not the user's cancel: TIDAL was hidden or the window failed before it showed
		if (!asked?.shown) return { answer: false, refused: "its window could not be shown over TIDAL" };
		// Closing the window is a cancel
		const confirmed = asked.answer === "yes";
		const action = actionToRun(confirmed, warningChosen, warning);
		// Runs after the window's turn: revokeAllVersions is synchronous, so it is done before the next prompt reads its warning.
		// Before the answer counts: what it confirms (an update, say) must find the action done. If it fails, the
		// confirmation fails: the asker (registry.ts) does nothing, and the renderer shows why
		if (action !== undefined)
			try {
				await action();
			} catch (err: any) {
				console.error("[🛑Security🛑] The confirmation's warning action failed", err);
				throw new Error(`[Luna.core] "${warning?.action}" failed, so "${request.title}" is not confirmed: ${err?.message ?? err}`);
			}
		answer = confirmed;
		return { answer };
	} finally {
		gate.answered(answer, Date.now());
	}
};

/**
 * Asks the user to pick one of `request.choices`: `choice` is its id, undefined if they closed the window. `refused`
 * as in askConfirm, from the host questions' own gate. Any pick (Deny too) is an answer for the gate, a close a cancel
 */
const askChoice = async (
	request: ConfirmRequest,
	parent: BrowserWindow | undefined,
	recentUserInput: boolean,
): Promise<{ choice?: string; refused?: string }> => {
	const owner = NativeConfirm.visibleOwner(parent);
	watch(owner);
	const refused = hostGate.refuse({
		tidal: { visible: owner !== undefined, focused: owner?.isFocused() === true, recentUserInput },
		now: Date.now(),
	});
	if (refused !== undefined) {
		console.warn(`[🛑Security🛑] Did not ask "${request.title}": ${refused}`);
		return { refused };
	}
	let answer: string | undefined;
	try {
		const asked = await confirmWindow.ask(parent, () => ({
			html: buildChoiceHtml(request),
			answers: ["no", ...(request.choices ?? []).map((choice) => `choice:${choice.id}`)],
		}));
		// Not the user's cancel: TIDAL was hidden or the window failed before it showed
		if (!asked?.shown) return { refused: "its window could not be shown over TIDAL" };
		// Closed without an answer (or Escape): a cancel
		answer = asked.answer ?? "no";
		return { choice: isHostAnswer(answer) ? answer.slice("choice:".length) : undefined };
	} finally {
		hostGate.answered(answer === undefined ? undefined : isHostAnswer(answer), Date.now(), answer !== undefined && isHostDeny(answer));
	}
};

// #region Who asks
/** When the preload last saw a trusted click or key in a renderer: webContents id -> Date.now() */
const lastInput = new Map<number, number>();
/** Who waits for the user's next click or key in a renderer (a host question waiting for TIDAL): webContents id -> listeners */
const inputListeners = new Map<number, Set<() => void>>();
const inputOf = (id: number) => ({
	on: (listener: () => void) => {
		let listeners = inputListeners.get(id);
		if (listeners === undefined) inputListeners.set(id, (listeners = new Set()));
		listeners.add(listener);
	},
	off: (listener: () => void) => {
		const listeners = inputListeners.get(id);
		listeners?.delete(listener);
		if (listeners?.size === 0) inputListeners.delete(id);
	},
});
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
	for (const listener of [...(inputListeners.get(sender.id) ?? [])]) listener();
});

/**
 * Asks the user of the renderer that sent `event`, in a window over it. Whether they used TIDAL just before is taken
 * now, when the request arrives: work before the question can take a while. Throws (notAsked) when the gate refused, so
 * the user learns why nothing opened.
 */
export const askerFor = (sender: Electron.WebContents) => {
	const parent = BrowserWindow.fromWebContents(sender) ?? undefined;
	const recentUserInput = Date.now() - (lastInput.get(sender.id) ?? -Infinity) < USER_INPUT_MS;
	return async ({ title, lines, confirmText, warning }: ConfirmRequest): Promise<boolean> => {
		// Luna's own text lines past the limit are packed (lines with links stay as they are, an update's notes among them)
		const fitted = Array.isArray(lines) ? fitConfirmLines(lines) : lines;
		const request = confirmRequest(title, fitted, confirmText, warning);
		const { answer, refused } = await askConfirm(request, parent, recentUserInput);
		if (refused === undefined) return answer;
		throw notAsked(request.title, refused);
	};
};

/**
 * Asks the user of the renderer that sent `event` one of `choices` (a host for luna.fetch, net.ts). Undefined if they
 * closed the window; throws (notAsked) if no window could open
 */
export const choiceAskerFor = (sender: Electron.WebContents) => {
	const parent = BrowserWindow.fromWebContents(sender) ?? undefined;
	const recentUserInput = Date.now() - (lastInput.get(sender.id) ?? -Infinity) < USER_INPUT_MS;
	return async (title: string, lines: string[], choices: { id: string; label: string }[]): Promise<string | undefined> => {
		const request = { ...confirmRequest(title, fitLines(lines), "-"), choices };
		let { choice, refused } = await askChoice(request, parent, recentUserInput);
		// Asked while TIDAL isn't in use (a request in the background): the question waits until the user is back
		if (refused === NOT_IN_USE && parent !== undefined) {
			const back = await waitForTidal(() => focusedWithin(parent, HOST_WAIT_MS, inputOf(sender.id)));
			// Back by a click or key: that is the use the gate looks for, where focus isn't reported
			const input = () => Date.now() - (lastInput.get(sender.id) ?? -Infinity) < USER_INPUT_MS;
			if (back) ({ choice, refused } = await afterWait(() => askChoice(request, parent, input())));
		}
		if (refused === undefined) return choice;
		throw notAsked(request.title, refused);
	};
};
// #endregion
