// The page of Luna's confirmation window (confirmWindow.ts) and when it may open, kept apart so it can be tested without Electron.
import { escapeHtml, promptPage } from "../NativeConfirm/page";

/** A link in a confirmation: main opens its http(s) url in the browser (confirmWindow.ts) */
export type ConfirmLink = { text: string; href: string };
/** A line of text, or of text and links */
export type ConfirmLine = string | (string | ConfirmLink)[];
/**
 * A warning above the buttons with a button of its own (revoke an answer, say). Clicking it chooses the action: `done`
 * replaces the warning, and main calls `run` only if the user then confirms, before the answer counts. If `run` throws,
 * the confirmation fails (rejects).
 */
export type ConfirmWarning = { text: string; action: string; done: string; run: () => void | Promise<void> };
/**
 * `warning` may be a function: the window calls it when it shows, so a request that waited behind other prompts warns
 * about the state then (an answer given in one of them, say)
 */
export type ConfirmRequest = {
	title: string;
	lines: ConfirmLine[];
	confirmText: string;
	warning?: ConfirmWarning | (() => ConfirmWarning | undefined);
};

const MAX_LINES = 12;
const MAX_TEXT = 600;
/** Confirmations open or waiting at once; more are cancelled */
export const MAX_PENDING = 3;
/** After this many cancels in a row, confirmations are refused for COOL_DOWN_MS: page code asking again after each cancel */
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
 * Decides whether a confirmation may open (confirmWindow.ts). Page code can ask for confirmations through the core
 * (installs, enables, updates, and the core natives in policy.ts), so it must not be able to fill the queue, pop windows while the user is
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

/** An http(s) url, normalized (`new URL`), else undefined: the only links a confirmation opens */
export const httpLink = (href: unknown): string | undefined => {
	if (typeof href !== "string") return undefined;
	try {
		const url = new URL(href);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
	} catch {
		return undefined;
	}
};

/** Checks a request: texts are strings (long ones cut), links http(s), a warning's run a function */
export const confirmRequest = (title: unknown, lines: unknown, confirmText: unknown, warning?: unknown): ConfirmRequest => {
	const text = (value: unknown) => {
		if (typeof value !== "string") throw new Error("[Luna.core] Confirmation texts must be strings");
		return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
	};
	const part = (value: unknown): string | ConfirmLink => {
		if (typeof value === "string") return text(value);
		const { text: linkText, href } = (value ?? {}) as Partial<ConfirmLink>;
		const link = httpLink(href);
		if (link === undefined) throw new Error("[Luna.core] Confirmation links must be http(s)");
		return { text: text(linkText), href: link };
	};
	const line = (value: unknown): ConfirmLine => (Array.isArray(value) ? value.map(part) : text(value));
	if (!Array.isArray(lines) || lines.length > MAX_LINES) throw new Error("[Luna.core] Bad confirmation lines");
	const request: ConfirmRequest = { title: text(title), lines: lines.map(line), confirmText: text(confirmText) };
	if (request.title === "" || request.confirmText === "") throw new Error("[Luna.core] A confirmation needs a title and a button");
	const checked = (value: unknown): ConfirmWarning | undefined => {
		if (value === undefined) return undefined;
		const { text: warningText, action, done, run } = value as Partial<ConfirmWarning>;
		if (typeof run !== "function") throw new Error("[Luna.core] A confirmation warning needs an action");
		return { text: text(warningText), action: text(action), done: text(done), run };
	};
	if (typeof warning === "function") request.warning = () => checked(warning());
	else if (warning !== undefined) request.warning = checked(warning);
	return request;
};

/** The warning a window shows: a function's is taken now */
export const shownWarning = ({ warning }: Pick<ConfirmRequest, "warning">): ConfirmWarning | undefined =>
	typeof warning === "function" ? warning() : warning;

/** What runs when the window closes: the warning's action, only if the user chose it and then confirmed */
export const actionToRun = (answer: boolean | undefined, chosen: boolean, warning: ConfirmWarning | undefined) =>
	answer === true && chosen ? warning?.run : undefined;

/** The links of a request in the order the page numbers them (`link:<index>`) */
export const confirmLinks = ({ lines }: Pick<ConfirmRequest, "lines">): string[] =>
	lines.flatMap((line) => (typeof line === "string" ? [] : line.flatMap((part) => (typeof part === "string" ? [] : [part.href]))));

const lineHtml = (line: ConfirmLine, next: () => number) =>
	typeof line === "string"
		? escapeHtml(line)
		: line
				.map((part) =>
					typeof part === "string"
						? escapeHtml(part)
						: `<a href="#" data-link="${next()}" title="${escapeHtml(part.href)}">${escapeHtml(part.text)}</a>`,
				)
				.join("");

// The confirm button is armed by the window (data-arm, see promptPage). Clicks on links and the warning's action are
// notes (`link:<index>`, `action`) that confirmWindow.ts acts on
export const buildConfirmHtml = ({ title, lines, confirmText, warning }: Omit<ConfirmRequest, "warning"> & { warning?: ConfirmWarning }) => {
	let links = 0;
	const next = () => links++;
	return promptPage({
		title: "Luna",
		style: `h1 { font-size:22px; font-weight:700; margin:4px 0 14px; overflow-wrap:anywhere; }
p { color:#c4c4cc; line-height:1.45; margin-bottom:8px; overflow-wrap:anywhere; }
.by { color:#5eead4; font-size:12px; margin-top:12px; }
.actions { display:flex; justify-content:flex-end; gap:10px; margin-top:18px; }
.actions button { padding:10px 20px; border-radius:6px; font-size:15px; font-weight:700; }
#cancel { background:#2a2a2a; color:#f4f4f5; }
#cancel:hover { background:#353535; }
#confirm { background:#f4f4f5; color:#0a0a0a; }
a { color:#5eead4; }
.warning { display:flex; align-items:center; gap:12px; background:#3a2a08; color:#fcd34d; border-radius:6px; padding:10px 12px; margin-top:10px; overflow-wrap:anywhere; }
.warning span { flex:1; }
#warning-action { background:transparent; color:#fcd34d; border:1px solid #fcd34d; border-radius:6px; padding:6px 12px; font-size:13px; font-weight:700; white-space:nowrap; }`,
		body: `<div class="eyebrow">Luna</div>
<h1>${escapeHtml(title)}</h1>
${lines.map((line) => `<p>${lineHtml(line, next)}</p>`).join("\n")}
${warning === undefined ? "" : `<div class="warning"><span id="warning-text">${escapeHtml(warning.text)}</span><button id="warning-action">${escapeHtml(warning.action)}</button></div>`}
<p class="by">Asked by Luna in its own window. Plugins and page scripts can't see or answer it.</p>
<div class="actions"><button id="cancel">Cancel</button><button id="confirm" data-arm disabled>${escapeHtml(confirmText)}</button></div>`,
		script: `for (const link of document.querySelectorAll("a[data-link]"))
	link.addEventListener("click", (event) => (event.preventDefault(), note("link:" + link.dataset.link)));
document.getElementById("warning-action")?.addEventListener("click", () => note("action"));
// The user chose the warning's action: its text replaces the warning
window.warningDone = (text) => {
	document.getElementById("warning-text").textContent = text;
	document.getElementById("warning-action").remove();
};
document.getElementById("cancel").addEventListener("click", () => submit("no"));
document.getElementById("confirm").addEventListener("click", () => submit("yes"));
document.addEventListener("keydown", (event) => event.key === "Escape" && submit("no"));
document.getElementById("cancel").focus();`,
	});
};
