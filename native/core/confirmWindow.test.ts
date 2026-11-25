import { beforeEach, describe, expect, it, vi } from "vitest";

import { notAskedMessage } from "./notAsked";

/**
 * askerFor is what a core native's confirmation goes through: the request is checked, the gate decides whether a window
 * may open, the window's answer becomes true or false, and a refusal throws with its reason. confirmPage.test.ts
 * covers the gate and the page as pure code; the window itself is NativeConfirm.test.ts, so it is stubbed here.
 */
const mocks = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../NativeConfirm/NativeConfirm", () => ({
	NativeConfirm: class {
		static visibleOwner = (win?: { isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean }) =>
			win !== undefined && !win.isDestroyed() && win.isVisible() && !win.isMinimized() ? win : undefined;
		ask = mocks.ask;
	},
}));

type InputHandler = (event: { sender: unknown }, active: unknown) => unknown;
let BrowserWindow: typeof import("electron").BrowserWindow;
let askerFor: typeof import("./confirmWindow").askerFor;
let userInput: InputHandler;

const fakeTidal = ({ focused = true, visible = true } = {}) => {
	const handlers: Record<string, () => void> = {};
	const win = {
		isDestroyed: () => false,
		isVisible: () => visible,
		isMinimized: () => false,
		isFocused: () => focused,
		on: vi.fn((event: string, handler: () => void) => void (handlers[event] = handler)),
	};
	return { win, handlers };
};

let nextId = 100;
/** A renderer, and the TIDAL window it is in */
const renderer = (options?: Parameters<typeof fakeTidal>[0]) => {
	const tidal = fakeTidal(options);
	const sender = Object.assign(new (class {})(), { id: ++nextId, once: vi.fn() });
	vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(tidal.win as never);
	return { sender, ...tidal };
};
const request = { title: "Update Luna?", lines: ["Download it"], confirmText: "Update" };
const answerWith = (answer: "yes" | "no" | undefined) => mocks.ask.mockResolvedValue({ shown: true, answer });

beforeEach(async () => {
	mocks.ask.mockReset();
	vi.useRealTimers();
	// The gate and the input times are module state: every test gets a fresh one
	vi.resetModules();
	({ askerFor } = await import("./confirmWindow"));
	const electron = await import("electron");
	BrowserWindow = electron.BrowserWindow;
	userInput = vi.mocked(electron.ipcMain.on).mock.calls.findLast(([channel]) => channel === "__Luna.userInput")![1] as unknown as InputHandler;
});

describe("askerFor", () => {
	it("is true only when the user clicked the confirm button", async () => {
		answerWith("yes");
		await expect(askerFor(renderer().sender as never)(request)).resolves.toBe(true);

		answerWith("no");
		await expect(askerFor(renderer().sender as never)(request)).resolves.toBe(false);

		// Closing the window is a cancel
		answerWith(undefined);
		await expect(askerFor(renderer().sender as never)(request)).resolves.toBe(false);
	});

	it("opens the window over TIDAL's window, with the page for the request", async () => {
		answerWith("yes");
		const { sender, win } = renderer();

		await askerFor(sender as never)(request);

		const [parent, prompt] = mocks.ask.mock.calls[0];
		expect(parent).toBe(win);
		const { html, answers } = prompt();
		expect(answers).toEqual(["yes", "no"]);
		expect(html).toContain("Update Luna?");
		expect(html).toContain("data-arm");
	});

	it("checks the request before it asks: strings only", async () => {
		const ask = askerFor(renderer().sender as never);

		await expect(ask({ title: 1 as never, lines: [], confirmText: "ok" })).rejects.toThrow("must be strings");
		await expect(ask({ title: "t", lines: "x" as never, confirmText: "ok" })).rejects.toThrow("Bad confirmation lines");
		await expect(ask({ title: "", lines: [], confirmText: "ok" })).rejects.toThrow("needs a title and a button");

		expect(mocks.ask).not.toHaveBeenCalled();
	});

	it("throws the reason, readable with notAskedMessage, when TIDAL is not in use", async () => {
		const err = await askerFor(renderer({ focused: false }).sender as never)(request).catch((e) => e);

		expect(notAskedMessage(err)).toBe('"Update Luna?" was not asked: TIDAL is not in use');
		expect(mocks.ask).not.toHaveBeenCalled();
	});

	it("takes a trusted click or key in TIDAL as using it when the focus isn't reported", async () => {
		answerWith("yes");
		const { sender } = renderer({ focused: false });

		userInput({ sender }, true);

		await expect(askerFor(sender as never)(request)).resolves.toBe(true);
	});

	it("stops counting input once the preload says it ended (the user left TIDAL)", async () => {
		const { sender } = renderer({ focused: false });
		userInput({ sender }, true);
		userInput({ sender }, false);

		await expect(askerFor(sender as never)(request)).rejects.toThrow("TIDAL is not in use");
	});

	it("ignores user input that isn't a plain true, and stops counting it after a while", async () => {
		answerWith("yes");
		const { sender } = renderer({ focused: false });

		userInput({ sender }, "yes");
		await expect(askerFor(sender as never)(request)).rejects.toThrow("TIDAL is not in use");

		vi.useFakeTimers();
		userInput({ sender }, true);
		vi.advanceTimersByTime(10_001);
		await expect(askerFor(sender as never)(request)).rejects.toThrow("TIDAL is not in use");
	});

	it("forgets a renderer's input when it is destroyed, and listens for that once however often it sends input", async () => {
		const { sender } = renderer({ focused: false });
		userInput({ sender }, true);
		userInput({ sender }, true);
		expect(sender.once).toHaveBeenCalledTimes(1);
		const [event, onDestroyed] = sender.once.mock.calls[0];
		expect(event).toBe("destroyed");

		onDestroyed();

		await expect(askerFor(sender as never)(request)).rejects.toThrow("TIDAL is not in use");
	});

	it("does not count input of another renderer", async () => {
		const { sender } = renderer({ focused: false });
		const other = renderer({ focused: false });
		userInput({ sender: other.sender }, true);
		vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);

		await expect(askerFor(sender as never)(request)).rejects.toThrow("TIDAL is not in use");
	});

	it("never opens over a hidden TIDAL", async () => {
		const { sender } = renderer({ visible: false });
		userInput({ sender }, true);

		await expect(askerFor(sender as never)(request)).rejects.toThrow("TIDAL is not in use");
	});

	it("throws when the window couldn't be shown, which is not a cancel", async () => {
		mocks.ask.mockResolvedValue({ shown: false });

		const err = await askerFor(renderer().sender as never)(request).catch((e) => e);

		expect(notAskedMessage(err)).toContain("its window could not be shown over TIDAL");
	});

	it("refuses to ask again for a minute after several cancels in a row", async () => {
		answerWith("no");
		const { sender } = renderer();
		const ask = () => askerFor(sender as never)(request);

		for (let i = 0; i < 4; i++) await expect(ask()).resolves.toBe(false);

		await expect(ask()).rejects.toThrow("cancelled in a row");
		expect(mocks.ask).toHaveBeenCalledTimes(4);
	});

	it("ends the use of TIDAL after the user's answer when they leave its window", async () => {
		answerWith("yes");
		const { sender, handlers } = renderer({ focused: false });
		userInput({ sender }, true);
		await askerFor(sender as never)(request);

		// Only the answer counts as use now: the user clicks away from TIDAL, and the page asks again
		userInput({ sender }, false);
		handlers.blur();

		await expect(askerFor(sender as never)(request)).rejects.toThrow("TIDAL is not in use");
	});
});
