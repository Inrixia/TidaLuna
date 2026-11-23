// The page of Luna's confirmation window (confirmWindow.ts), kept apart so it can be tested without Electron.
import { escapeHtml } from "../NativeModule/permissions/escapeHtml";

export type ConfirmRequest = { title: string; lines: string[]; confirmText: string };

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
/** After this many cancels in a row, confirmations are refused for COOL_DOWN_MS: page code calling an update again after each cancel */
export const MAX_CANCELS = 4;
export const COOL_DOWN_MS = 60_000;
/** A trusted click or key in TIDAL counts as using it this long (the preload reports them, see confirmWindow.ts) */
export const USER_INPUT_MS = 10_000;
/** An answer in a confirmation window counts as using TIDAL this long (the next of several installs follows it) */
export const ANSWER_IN_USE_MS = 10_000;

/** What main knows about TIDAL's window when a request comes */
export type TidalState = {
	visible: boolean;
	focused: boolean;
	/** The preload saw a trusted click or key in TIDAL just before (focus alone is not reported by every Linux window manager) */
	recentUserInput: boolean;
};

/**
 * Decides whether a confirmation may open (confirmWindow.ts). Page code can call the core natives that ask (update,
 * startNativeDebugging, see policy.ts), so it must not be able to fill the queue, pop windows while the user is
 * elsewhere, or show a new one after every cancel.
 */
export const confirmGate = () => {
	let pending = 0;
	let cancelsInARow = 0;
	let lastCancel = 0;
	let refusedUntil = 0;
	let lastAnswer = -Infinity;
	return {
		/** Why this request is refused, or undefined if it may ask */
		refuse({ tidal, now }: { tidal: TidalState; now: number }): string | undefined {
			// A user's request comes from a click in TIDAL, or follows their answer to the last confirmation
			const inUse = tidal.visible && (tidal.focused || tidal.recentUserInput || now - lastAnswer < ANSWER_IN_USE_MS);
			if (!inUse) return "TIDAL is not in use";
			if (now < refusedUntil)
				return `${MAX_CANCELS} confirmations were cancelled in a row, asking again in ${Math.ceil((refusedUntil - now) / 1000)} s`;
			if (pending >= MAX_PENDING) return `${pending} confirmations are already waiting`;
			pending++;
			return undefined;
		},
		/** A request that was let through got its answer, or undefined if no window could be shown (not the user's cancel) */
		answered(answer: boolean | undefined, now: number) {
			pending--;
			if (answer === undefined) return;
			lastAnswer = now;
			if (answer) {
				cancelsInARow = 0;
				return;
			}
			// Cancels long apart are the user's own choices, not a page asking again and again
			if (now - lastCancel > COOL_DOWN_MS) cancelsInARow = 0;
			lastCancel = now;
			if (++cancelsInARow >= MAX_CANCELS) {
				refusedUntil = now + COOL_DOWN_MS;
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
