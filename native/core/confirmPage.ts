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
	/**
	 * Answers instead of Cancel/confirm, in order (the last one is drawn as the main button). All of them are armed like
	 * the confirm button (none answers before the window was seen). Closing the window answers none of them
	 */
	choices?: { id: string; label: string }[];
};

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
export const fitLines = (lines: string[], max = MAX_LINES) => {
	if (lines.length <= max) return lines;
	const packed: string[] = [];
	for (const line of lines) {
		const last = packed.length - 1;
		if (last >= 0 && packed[last].length + 1 + line.length <= MAX_TEXT) packed[last] += ` ${line}`;
		else packed.push(line);
	}
	if (packed.length <= max) return packed;
	// The last line takes what fits and counts the rest: confirmRequest would cut it without saying how much
	const rest = packed.slice(max - 1);
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
		const suffix = ` \u2026 and ${rest.length - 1} more line${rest.length - 1 === 1 ? "" : "s"}`;
		return [...packed.slice(0, max - 1), `${rest[0].slice(0, MAX_TEXT - suffix.length)}${suffix}`];
	}
	return [...packed.slice(0, max - 1), counted(last, rest.length - taken)];
};

/**
 * fitLines for a request's lines that may hold lines with links (an update's versions and trust lines): those stay as
 * they are and Luna's text lines among them are packed into the room left
 */
export const fitConfirmLines = (lines: ConfirmLine[]): ConfirmLine[] => {
	if (lines.length <= MAX_LINES) return lines;
	const texts = lines.filter((line): line is string => typeof line === "string");
	const fitted = fitLines(texts, Math.max(1, MAX_LINES - (lines.length - texts.length)));
	const first = lines.findIndex((line) => typeof line === "string");
	return [...lines.slice(0, first), ...fitted, ...lines.slice(first).filter((line) => typeof line !== "string")];
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
const choiceId = /^[a-z]{1,16}$/;

export const buildConfirmHtml = ({
	title,
	lines,
	confirmText,
	warning,
	choices,
}: Omit<ConfirmRequest, "warning"> & { warning?: ConfirmWarning }) => {
	if (choices !== undefined && (choices.length < 2 || choices.some((choice) => !choiceId.test(choice.id))))
		throw new Error("[Luna.core] Bad choices");
	let links = 0;
	const next = () => links++;
	return promptPage({
		title: "Luna",
		style: `h1 { font-size:22px; font-weight:700; margin:4px 0 14px; overflow-wrap:anywhere; }
p { color:#c4c4cc; line-height:1.45; margin-bottom:8px; overflow-wrap:anywhere; }
.by { color:#5eead4; font-size:12px; margin-top:12px; }
.actions { display:flex; justify-content:flex-end; gap:10px; margin-top:18px; }
.actions button { padding:10px 20px; border-radius:6px; font-size:15px; font-weight:700; }
#cancel, .choice { background:#2a2a2a; color:#f4f4f5; }
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
${
	choices === undefined
		? `<div class="actions"><button id="cancel">Cancel</button><button id="confirm" data-arm disabled>${escapeHtml(confirmText)}</button></div>`
		: `<div class="actions">${choices
				.map(
					(choice, index) =>
						`<button class="choice" data-id="${choice.id}"${index === choices.length - 1 ? ' id="confirm"' : ""}${index === 0 ? ' id="cancel"' : ""} data-arm disabled>${escapeHtml(choice.label)}</button>`,
				)
				.join("")}</div>`
}`,
		script:
			choices !== undefined
				? // Every choice is kept (the first, deny, too), so all wait to be armed, and the focus is on none: Enter typed into TIDAL
					// as the window shows picks nothing. Escape closes it, which keeps nothing
					`for (const button of document.querySelectorAll("button.choice")) button.addEventListener("click", () => submit("choice:" + button.dataset.id));
document.addEventListener("keydown", (event) => event.key === "Escape" && submit("no"));
document.body.tabIndex = -1;
document.body.focus();`
				: `for (const link of document.querySelectorAll("a[data-link]"))
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

/** The page of a host question: only its choices answer (see askChoice) */
export const buildChoiceHtml = (request: ConfirmRequest) => buildConfirmHtml({ ...request, warning: undefined });
