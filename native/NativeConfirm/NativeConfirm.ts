// Luna's prompt windows: the native permission window (NativeModule/permissions/window.ts) and Luna's confirmations
// (core/confirmWindow.ts). Page code can cover, restyle or remove anything in TIDAL's page, so a prompt drawn there can be
// clickjacked. A NativeConfirm window is a separate webContents (own session, no preload, a static page with a strict CSP,
// see page.ts) that nothing in the page can see, cover or click, and only one is open at a time.
import { BrowserWindow } from "electron";

import { FIT, NOTE, SUBMIT } from "./page";

/**
 * Buttons with `data-arm` stay disabled this long after the window shows or gets the focus back: a click meant for TIDAL
 * or another window can't land on them
 */
const ARM_DELAY_MS = 700;

type NativeConfirmOptions = {
	/** The window's own session */
	partition: string;
	title: string;
	width: number;
	/** The window is fitted to its page between these heights */
	minHeight: number;
	maxHeight: number;
	resizable?: boolean;
	/** Without a visible TIDAL window: show the prompt on its own (true) or not at all */
	showUnowned: boolean;
	/** Script returning the height the page needs, default the body's scrollHeight */
	measure?: string;
};

/** What a window shows, taken when its turn comes (see ask) */
type Prompt<A extends string> = {
	/** A page built with promptPage (page.ts) */
	html: string;
	/** The answers `submit` may give: anything else closes the window without one */
	answers: readonly A[];
	/** A click that doesn't answer (`note(what)` in the page), other than FIT. `run` runs a script in the page */
	onNote?: (what: string, run: (script: string) => void) => void;
};

/** `shown` is false if no window could be shown; `answer` is undefined if the user closed it without one */
type Asked<A extends string> = { shown: false } | { shown: true; answer: A | undefined };

export class NativeConfirm<A extends string> {
	// One prompt window at a time, of any kind: two modals over TIDAL could be answered in the wrong order
	private static queue: Promise<unknown> = Promise.resolve();

	/** The TIDAL window a prompt may belong to: not a minimized or hidden one, the prompt would be hidden with it */
	static visibleOwner(parent?: BrowserWindow) {
		return parent !== undefined && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized() ? parent : undefined;
	}

	constructor(private readonly options: NativeConfirmOptions) {}

	/**
	 * Asks once the prompts before it are answered, and resolves when the window closes.
	 *
	 * @param prompt Called when the window's turn comes: a window before it may have answered what this one was to ask.
	 * Returns undefined if nothing is left to ask, and ask resolves with undefined.
	 */
	ask(parent: BrowserWindow | undefined, prompt: () => Prompt<A> | undefined): Promise<Asked<A> | undefined> {
		const task = async () => {
			const shown = prompt();
			return shown === undefined ? undefined : this.show(parent, shown);
		};
		const result = NativeConfirm.queue.then(task, task);
		NativeConfirm.queue = result.catch(() => {});
		return result;
	}

	private show(parent: BrowserWindow | undefined, { html, answers, onNote }: Prompt<A>) {
		return new Promise<Asked<A>>((resolve) => {
			// TIDAL may have been hidden while earlier prompts were answered
			const owner = NativeConfirm.visibleOwner(parent);
			if (owner === undefined && !this.options.showUnowned) return resolve({ shown: false });
			const { partition, title, width, minHeight, maxHeight, resizable = false, measure = "document.body.scrollHeight" } = this.options;
			const win = new BrowserWindow({
				parent: owner,
				modal: owner !== undefined,
				width,
				height: minHeight,
				useContentSize: true,
				resizable,
				minimizable: false,
				maximizable: false,
				fullscreenable: false,
				autoHideMenuBar: true,
				backgroundColor: "#0a0a0a",
				title,
				show: false,
				webPreferences: {
					partition,
					sandbox: true,
					contextIsolation: true,
					nodeIntegration: false,
					devTools: false,
					spellcheck: false,
				},
			});
			win.removeMenu();
			// The page is ours and static: nothing in it may navigate or open windows
			win.webContents.on("will-navigate", (event) => event.preventDefault());
			win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
			// A window that can't show would hold up every later prompt (see ask)
			win.webContents.once("render-process-gone", () => !win.isDestroyed() && win.destroy());
			win.webContents.once("did-fail-load", () => !win.isDestroyed() && win.destroy());

			const run = (script: string) => !win.isDestroyed() && void win.webContents.executeJavaScript(script).catch(() => {});
			// Fits the window to its page, also when the page asks (a list opened, say)
			const fit = (first: boolean) =>
				win.webContents
					.executeJavaScript(measure)
					.then((height: unknown) => {
						if (win.isDestroyed() || typeof height !== "number" || !Number.isFinite(height)) return;
						const [contentWidth] = win.getContentSize();
						win.setContentSize(contentWidth, Math.round(Math.min(Math.max(Math.ceil(height), minHeight), maxHeight)));
					})
					.catch(() => {})
					// Centred once, at its first size: the user may have moved it since
					.finally(() => first && !win.isDestroyed() && win.center());

			let shown = false;
			let answer: A | undefined;
			let submitted = false;
			win.on("page-title-updated", (event, pageTitle) => {
				if (pageTitle.startsWith(NOTE)) {
					event.preventDefault();
					const what = pageTitle.slice(NOTE.length).replace(/#\d+$/, "");
					if (what === FIT) void fit(false);
					else onNote?.(what, run);
					return;
				}
				if (!pageTitle.startsWith(SUBMIT)) return;
				event.preventDefault();
				// The first answer stands: a second title change before the window closes doesn't replace it
				if (submitted) return;
				submitted = true;
				const value = pageTitle.slice(SUBMIT.length);
				answer = answers.find((allowed) => allowed === value);
				win.close();
			});

			// Armed ARM_DELAY_MS after the window shows and after every time it gets the focus back: another window (a dialog
			// of an allowed native, say) can cover it, and a click meant for that one must not answer.
			// Not isFocused(): some Linux window managers never report the focus, and the buttons must still arm there
			let armTimer: ReturnType<typeof setTimeout> | undefined;
			let blurred = false;
			const armLater = () => {
				clearTimeout(armTimer);
				armTimer = setTimeout(() => !blurred && run("window.arm(true)"), ARM_DELAY_MS);
			};
			win.on("blur", () => {
				blurred = true;
				clearTimeout(armTimer);
				run("window.arm(false)");
			});
			win.on("focus", () => {
				blurred = false;
				if (win.isVisible()) armLater();
			});

			win.once("show", () => (shown = true));
			win.once(
				"ready-to-show",
				() =>
					void fit(true).finally(() => {
						if (win.isDestroyed()) return;
						win.show();
						// A click meant for TIDAL that lands on the new window doesn't answer
						armLater();
					}),
			);
			win.once("closed", () => {
				clearTimeout(armTimer);
				resolve(shown ? { shown, answer } : { shown });
			});
			win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((err) => {
				console.error(`[🛑Security🛑] Failed to show the ${title} window`, err);
				if (!win.isDestroyed()) win.close();
			});
		});
	}
}
