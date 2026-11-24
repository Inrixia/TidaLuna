// The page of Luna's confirmation window (confirmWindow.ts), kept apart so it can be tested without Electron.
import { escapeHtml } from "../NativeModule/permissions/escapeHtml";

export type ConfirmRequest = {
	title: string;
	lines: string[];
	confirmText: string;
	/**
	 * Answers instead of Cancel/confirm, in order (the last one is drawn as the main button). All of them are armed like
	 * the confirm button (none answers before the window was seen). Closing the window answers none of them
	 */
	choices?: { id: string; label: string }[];
};

export const TITLE = "Luna";
export const SUBMIT = "luna-core-confirm:";
/**
 * The confirm button stays disabled this long after the window shows or gets the focus back: a click meant for TIDAL or
 * another window can't land on it
 */
export const ARM_DELAY_MS = 700;
const MAX_LINES = 12;
const MAX_TEXT = 600;
/** Confirmations open or waiting at once; more are cancelled */
export const MAX_PENDING = 3;
/** After this many cancels in a row, confirmations are refused for COOL_DOWN_MS: page code asking again after each cancel */
export const MAX_CANCELS = 4;
export const COOL_DOWN_MS = 60_000;
/** Host questions denied in a row before they cool down like cancels: page code asking for host after host */
export const MAX_DENIES = 12;
/** A trusted click or key in TIDAL counts as using it this long (the preload reports them, see confirmWindow.ts) */
export const USER_INPUT_MS = 10_000;
/** An answer in a confirmation window counts as using TIDAL this long (the next of several installs follows it) */
export const ANSWER_IN_USE_MS = 10_000;

/** confirmGate's refusal while TIDAL isn't in use (a host question waits for the user instead, confirmWindow.ts) */
export const NOT_IN_USE = "TIDAL is not in use";

/**
 * For the host questions' gate (confirmWindow.ts askChoice) any pick is an answer, "Deny" too: a user denying hosts
 * a plugin asks for in a burst is answering, not dismissing windows. Only a close counts as a cancel
 */
export const isHostAnswer = (raw: string) => raw.startsWith("choice:");
/** A host question's "Deny": an answer, but many in a row are a plugin asking for host after host (confirmGate) */
export const isHostDeny = (raw: string) => raw === "choice:deny";

/**
 * Lets at most `max` waits run at once: past them it answers false at once (a host question that can't wait for TIDAL
 * is refused as before the wait existed). A wait that throws frees its place
 */
export const limitedWait = (max: number) => {
	let waiting = 0;
	return async (wait: () => Promise<boolean>): Promise<boolean> => {
		if (waiting >= max) return false;
		waiting++;
		try {
			return await wait();
		} finally {
			waiting--;
		}
	};
};

/** Runs the functions it is given one after another, each once the one before settled (a failure doesn't stop the rest) */
export const oneAtATime = () => {
	let last: Promise<unknown> = Promise.resolve();
	return <T>(run: () => Promise<T>): Promise<T> => {
		const next = last.then(run);
		last = next.catch(() => undefined);
		return next;
	};
};

/** The part of a BrowserWindow focusedWithin uses */
export type FocusTarget = {
	isDestroyed(): boolean;
	isFocused(): boolean;
	on(event: "focus" | "closed", listener: () => void): unknown;
	off(event: "focus" | "closed", listener: () => void): unknown;
};

/** Tells a listener of the user's clicks and keys in TIDAL (the preload's trusted events) */
export type InputSource = { on(listener: () => void): unknown; off(listener: () => void): unknown };

/**
 * Resolves true once `win` has the focus (at once if it has) or the user clicks or types in it (`input`: not every Linux
 * window manager reports focus), false after `ms` or if it closes first
 */
export const focusedWithin = (win: FocusTarget, ms: number, input?: InputSource) =>
	new Promise<boolean>((resolve) => {
		if (win.isDestroyed()) return resolve(false);
		if (win.isFocused()) return resolve(true);
		const done = (focused: boolean) => {
			clearTimeout(timer);
			win.off("focus", onFocus);
			win.off("closed", onClosed);
			input?.off(onFocus);
			resolve(focused);
		};
		const onFocus = () => done(true);
		const onClosed = () => done(false);
		const timer = setTimeout(() => done(false), ms);
		win.on("focus", onFocus);
		win.on("closed", onClosed);
		input?.on(onFocus);
	});

/** What main knows about TIDAL's window when a request comes */
export type TidalState = {
	visible: boolean;
	focused: boolean;
	/** The preload saw a trusted click or key in TIDAL just before (focus alone is not reported by every Linux window manager) */
	recentUserInput: boolean;
};

/**
 * Decides whether a confirmation may open (confirmWindow.ts). Page code can ask for confirmations through the core
 * (installs, enables, updates, and the core natives in policy.ts), so it must not be able to fill the queue, pop windows while the user is
 * elsewhere, or show a new one after every cancel.
 */
export const confirmGate = () => {
	let pending = 0;
	let cancelsInARow = 0;
	let lastCancel = 0;
	let deniesInARow = 0;
	let lastDeny = 0;
	let refusedUntil = 0;
	let cooledBy = `${MAX_CANCELS} confirmations were cancelled in a row`;
	let lastAnswer = -Infinity;
	return {
		/** Why this request is refused, or undefined if it may ask */
		refuse({ tidal, now }: { tidal: TidalState; now: number }): string | undefined {
			// A user's request comes from a click in TIDAL, or follows their answer to the last confirmation
			const inUse = tidal.visible && (tidal.focused || tidal.recentUserInput || now - lastAnswer < ANSWER_IN_USE_MS);
			if (!inUse) return NOT_IN_USE;
			if (now < refusedUntil) return `${cooledBy}, asking again in ${Math.ceil((refusedUntil - now) / 1000)} s`;
			if (pending >= MAX_PENDING) return `${pending} confirmations are already waiting`;
			pending++;
			return undefined;
		},
		/**
		 * A request that was let through got its answer, or undefined if no window could be shown (not the user's cancel).
		 * `denied`: the answer was a host question's Deny
		 */
		answered(answer: boolean | undefined, now: number, denied = false) {
			pending--;
			if (answer === undefined) return;
			lastAnswer = now;
			if (answer) {
				cancelsInARow = 0;
				if (!denied) deniesInARow = 0;
				else {
					if (now - lastDeny > COOL_DOWN_MS) deniesInARow = 0;
					lastDeny = now;
					if (++deniesInARow >= MAX_DENIES) {
						refusedUntil = now + COOL_DOWN_MS;
						cooledBy = `${MAX_DENIES} hosts were denied in a row`;
						deniesInARow = 0;
					}
				}
				return;
			}
			// Cancels long apart are the user's own choices, not a page asking again and again
			if (now - lastCancel > COOL_DOWN_MS) cancelsInARow = 0;
			lastCancel = now;
			if (++cancelsInARow >= MAX_CANCELS) {
				refusedUntil = now + COOL_DOWN_MS;
				cooledBy = `${MAX_CANCELS} confirmations were cancelled in a row`;
				cancelsInARow = 0;
			}
		},
		/** The user left TIDAL: their last answer no longer counts as using it */
		left() {
			lastAnswer = -Infinity;
		},
		get pending() {
			return pending;
		},
	};
};

/**
 * Luna's own lines past the limit (an update that changes its natives and its hosts at once): short neighbours share a
 * line, so no text is cut; only if that isn't enough the rest goes into the last line
 */
export const fitLines = (lines: string[]) => {
	if (lines.length <= MAX_LINES) return lines;
	const packed: string[] = [];
	for (const line of lines) {
		const last = packed.length - 1;
		if (last >= 0 && packed[last].length + 1 + line.length <= MAX_TEXT) packed[last] += ` ${line}`;
		else packed.push(line);
	}
	if (packed.length <= MAX_LINES) return packed;
	// The last line takes what fits and counts the rest: confirmRequest would cut it without saying how much
	const rest = packed.slice(MAX_LINES - 1);
	let last = "";
	let taken = 0;
	const counted = (text: string, left: number) =>
		left === 0 ? text : `${text === "" ? "" : `${text} … `}and ${left} more line${left === 1 ? "" : "s"}`;
	for (const line of rest) {
		const next = last === "" ? line : `${last} ${line}`;
		if (counted(next, rest.length - taken - 1).length > MAX_TEXT) break;
		last = next;
		taken++;
	}
	if (taken === 0) {
		// Even the first line doesn't fit with the count: its start, then the count
		const suffix = ` \u2026 and ${rest.length - 1} more lines`;
		return [...packed.slice(0, MAX_LINES - 1), `${rest[0].slice(0, MAX_TEXT - suffix.length)}${suffix}`];
	}
	return [...packed.slice(0, MAX_LINES - 1), counted(last, rest.length - taken)];
};

/** Checks a request that came over IPC: strings only, long texts are cut */
export const confirmRequest = (title: unknown, lines: unknown, confirmText: unknown): ConfirmRequest => {
	const text = (value: unknown) => {
		if (typeof value !== "string") throw new Error("[Luna.core] Confirmation texts must be strings");
		return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
	};
	if (!Array.isArray(lines) || lines.length > MAX_LINES) throw new Error("[Luna.core] Bad confirmation lines");
	const request = { title: text(title), lines: lines.map(text), confirmText: text(confirmText) };
	if (request.title === "" || request.confirmText === "") throw new Error("[Luna.core] A confirmation needs a title and a button");
	return request;
};

const choiceId = /^[a-z]{1,16}$/;

export const buildChoiceHtml = ({ title, lines, choices = [] }: ConfirmRequest) => {
	if (choices.length < 2 || choices.some((choice) => !choiceId.test(choice.id))) throw new Error("[Luna.core] Bad choices");
	const actions = `<div class="actions">${choices
		.map(
			(choice, index) =>
				`<button class="choice" data-id="${choice.id}"${index === choices.length - 1 ? ' id="confirm"' : ""}${index === 0 ? ' id="cancel"' : ""} disabled>${escapeHtml(choice.label)}</button>`,
		)
		.join("")}</div>
<script>
const submit = (answer) => (document.title = "${SUBMIT}" + answer);
// Every choice is kept (the first, deny, too), so all wait to be armed, and the focus is on none: Enter typed into TIDAL
// as the window shows picks nothing. Escape closes it, which keeps nothing
const armed = [...document.querySelectorAll("button.choice")];
for (const button of document.querySelectorAll("button.choice")) button.addEventListener("click", () => submit("choice:" + button.dataset.id));
document.addEventListener("keydown", (event) => event.key === "Escape" && submit("no"));
document.body.tabIndex = -1;
document.body.focus();
window.arm = () => armed.forEach((button) => (button.disabled = false));
window.disarm = () => armed.forEach((button) => (button.disabled = true));
</script>`;
	return buildConfirmHtml({ title, lines, confirmText: "-" })
		.replace("</style>", () => ".choice { background:#2a2a2a; color:#f4f4f5; }\n.choice:disabled { opacity:.4; cursor:default; }\n</style>")
		.replace(/<div class="actions">[\s\S]*<\/script>/, () => actions);
};

export const buildConfirmHtml = ({ title, lines, confirmText }: ConfirmRequest) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${TITLE}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
:root { color-scheme:dark; }
body { background:#0a0a0a; color:#f4f4f5; font-family:system-ui,"Segoe UI",sans-serif; font-size:14px; padding:24px 28px 22px; user-select:none; }
.eyebrow { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:#8b8b93; font-weight:600; }
h1 { font-size:22px; font-weight:700; margin:4px 0 14px; overflow-wrap:anywhere; }
p { color:#c4c4cc; line-height:1.45; margin-bottom:8px; overflow-wrap:anywhere; }
.by { color:#5eead4; font-size:12px; margin-top:12px; }
.actions { display:flex; justify-content:flex-end; gap:10px; margin-top:18px; }
button { font:inherit; border:none; cursor:pointer; padding:10px 20px; border-radius:6px; font-size:15px; font-weight:700; }
#cancel { background:#2a2a2a; color:#f4f4f5; }
#cancel:hover { background:#353535; }
#confirm { background:#f4f4f5; color:#0a0a0a; }
#confirm:disabled { opacity:.4; cursor:default; }
:focus-visible { outline:2px solid #5eead4; outline-offset:2px; }
</style>
</head>
<body>
<div class="eyebrow">Luna</div>
<h1>${escapeHtml(title)}</h1>
${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")}
<p class="by">Asked by Luna in its own window. Plugins and page scripts can't see or answer it.</p>
<div class="actions"><button id="cancel">Cancel</button><button id="confirm" disabled>${escapeHtml(confirmText)}</button></div>
<script>
const submit = (answer) => (document.title = "${SUBMIT}" + answer);
const confirmButton = document.getElementById("confirm");
document.getElementById("cancel").addEventListener("click", () => submit("no"));
confirmButton.addEventListener("click", () => submit("yes"));
document.addEventListener("keydown", (event) => event.key === "Escape" && submit("no"));
document.getElementById("cancel").focus();
// Armed by main once the window shows or gets the focus back, disarmed when it loses it (see ARM_DELAY_MS)
window.arm = () => (confirmButton.disabled = false);
window.disarm = () => (confirmButton.disabled = true);
</script>
</body>
</html>`;
