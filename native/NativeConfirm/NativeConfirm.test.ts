import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeConfirm } from "./NativeConfirm";
import { NOTE, SUBMIT } from "./page";

/**
 * NativeConfirm is the window that stops page code from answering a prompt for the user: the arming delay, disarming on
 * blur, the first answer standing, the answers allowlist and the one-at-a-time queue all live in it. page.test.ts covers
 * the page's own script; these tests drive the window with a fake BrowserWindow that records what main does to it.
 */
const fake = vi.hoisted(() => {
	type Listener = (...args: any[]) => void;
	class Emitter {
		listeners = new Map<string, Listener[]>();
		on = (event: string, listener: Listener) => (this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]), this);
		once = (event: string, listener: Listener) => {
			const wrapped: Listener = (...args) => {
				this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== wrapped));
				listener(...args);
			};
			return this.on(event, wrapped);
		};
		emit = (event: string, ...args: any[]) => [...(this.listeners.get(event) ?? [])].forEach((listener) => listener(...args));
	}
	class FakeWindow extends Emitter {
		static instances: FakeWindow[] = [];
		destroyed = false;
		visible = true;
		minimized = false;
		scripts: string[] = [];
		webContents = Object.assign(new Emitter(), {
			setWindowOpenHandler: vi.fn(),
			executeJavaScript: vi.fn(async (script: string) => {
				this.scripts.push(script);
				return script === "document.body.scrollHeight" ? 300 : undefined;
			}),
		});
		loadURL = vi.fn(async (_url: string) => undefined);
		removeMenu = vi.fn();
		center = vi.fn();
		getContentSize = vi.fn((): [number, number] => [560, 180]);
		setContentSize = vi.fn();
		isDestroyed = () => this.destroyed;
		isVisible = () => this.visible;
		isMinimized = () => this.minimized;
		show = vi.fn(() => this.emit("show"));
		close = vi.fn(() => {
			this.destroyed = true;
			this.emit("closed");
		});
		destroy = vi.fn(() => {
			this.destroyed = true;
			this.emit("closed");
		});
		constructor(public options: Record<string, any>) {
			super();
			FakeWindow.instances.push(this);
		}
	}
	return { FakeWindow };
});
vi.mock("electron", () => ({ BrowserWindow: fake.FakeWindow }));

const { FakeWindow } = fake;
type Fake = InstanceType<typeof FakeWindow>;

const make = (showUnowned = true) =>
	new NativeConfirm<"yes" | "no">({ partition: "test-confirm", title: "Test", width: 500, minHeight: 100, maxHeight: 400, showUnowned });
const prompt = () => ({ html: "<p>hi</p>", answers: ["yes", "no"] as const });
const owner = () => new FakeWindow({}) as unknown as import("electron").BrowserWindow;
/** Lets queued microtasks (the queue, fit, the ready-to-show chain) run */
const settle = () => vi.advanceTimersByTimeAsync(0);
const latest = () => FakeWindow.instances[FakeWindow.instances.length - 1] as Fake;
const titled = (win: Fake, title: string) => {
	const event = { preventDefault: vi.fn() };
	win.emit("page-title-updated", event, title);
	return event;
};
/** The window's life up to being shown */
const open = async (win: Fake) => {
	win.emit("ready-to-show");
	await settle();
};
const armCalls = (win: Fake) => win.scripts.filter((script) => script.startsWith("window.arm"));

beforeEach(() => {
	vi.useFakeTimers();
	FakeWindow.instances.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("NativeConfirm window", () => {
	it("is a sandboxed window of its own: own session, no preload, no navigation, no new windows", async () => {
		const asked = make().ask(owner(), prompt);
		await settle();

		const win = latest();
		expect(win.options.webPreferences).toMatchObject({
			partition: "test-confirm",
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			devTools: false,
		});
		expect(win.options.webPreferences).not.toHaveProperty("preload");
		expect(win.options.modal).toBe(true);
		const navigate = { preventDefault: vi.fn() };
		win.webContents.emit("will-navigate", navigate);
		expect(navigate.preventDefault).toHaveBeenCalled();
		expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: "deny" });
		expect(win.loadURL.mock.calls[0][0]).toContain(encodeURIComponent("<p>hi</p>"));

		await open(win);
		win.close();
		await asked;
	});

	it("shows nothing without a visible TIDAL window when it may not show on its own", async () => {
		const hidden = owner() as unknown as Fake;
		hidden.visible = false;

		await expect(make(false).ask(undefined, prompt)).resolves.toEqual({ shown: false });
		await expect(make(false).ask(hidden as never, prompt)).resolves.toEqual({ shown: false });

		expect(FakeWindow.instances.filter((w) => w.options.webPreferences)).toEqual([]);
	});

	it("shows on its own, not modal, when it may", async () => {
		const asked = make(true).ask(undefined, prompt);
		await settle();

		expect(latest().options.modal).toBe(false);
		expect(latest().options.parent).toBeUndefined();
		await open(latest());
		latest().close();
		await asked;
	});

	it("answers nothing when there is nothing left to ask", async () => {
		await expect(make().ask(owner(), () => undefined)).resolves.toBeUndefined();
		expect(FakeWindow.instances.filter((w) => w.options.webPreferences)).toEqual([]);
	});
});

describe("answers", () => {
	const answered = async (...titles: string[]) => {
		const asked = make().ask(owner(), prompt);
		await settle();
		const win = latest();
		await open(win);
		titles.forEach((title) => titled(win, title));
		if (!win.destroyed) win.close();
		return asked;
	};

	it("takes a submitted answer and closes", async () => {
		await expect(answered(`${SUBMIT}yes`)).resolves.toEqual({ shown: true, answer: "yes" });
		await expect(answered(`${SUBMIT}no`)).resolves.toEqual({ shown: true, answer: "no" });
	});

	it("keeps the first answer when more come before the window closes", async () => {
		const asked = make().ask(owner(), prompt);
		await settle();
		const win = latest();
		await open(win);
		// The window closes on the first answer, but a second title change can still arrive before it is gone
		win.close = vi.fn();
		titled(win, `${SUBMIT}no`);
		titled(win, `${SUBMIT}yes`);
		expect(win.close).toHaveBeenCalledTimes(1);
		win.emit("closed");

		await expect(asked).resolves.toEqual({ shown: true, answer: "no" });
	});

	it("gives no answer for a value outside the allowed ones, and when the window is closed without one", async () => {
		await expect(answered(`${SUBMIT}maybe`)).resolves.toEqual({ shown: true, answer: undefined });
		await expect(answered(`${SUBMIT}`)).resolves.toEqual({ shown: true, answer: undefined });
		await expect(answered()).resolves.toEqual({ shown: true, answer: undefined });
	});

	it("keeps the page's title messages out of the window title", async () => {
		const asked = make().ask(owner(), prompt);
		await settle();
		const win = latest();

		expect(titled(win, `${SUBMIT}yes`).preventDefault).toHaveBeenCalled();
		expect(titled(win, `${NOTE}fit`).preventDefault).toHaveBeenCalled();
		expect(titled(win, "Some other title").preventDefault).not.toHaveBeenCalled();
		await asked;
	});

	it("says it was not shown when the window closes before it ever showed", async () => {
		const asked = make().ask(owner(), prompt);
		await settle();

		latest().close();

		await expect(asked).resolves.toEqual({ shown: false });
	});

	it("runs a note's handler, not for the fit request", async () => {
		const onNote = vi.fn();
		const asked = make().ask(owner(), () => ({ ...prompt(), onNote }));
		await settle();
		const win = latest();

		titled(win, `${NOTE}links#2`);
		titled(win, `${NOTE}fit#3`);

		expect(onNote).toHaveBeenCalledExactlyOnceWith("links", expect.any(Function));
		win.close();
		await asked;
	});
});

describe("arming the buttons", () => {
	it("arms only 700 ms after the window shows, so a click meant for TIDAL can't answer", async () => {
		const asked = make().ask(owner(), prompt);
		await settle();
		const win = latest();
		await open(win);
		expect(win.show).toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(699);
		expect(armCalls(win)).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(armCalls(win)).toEqual(["window.arm(true)"]);

		win.close();
		await asked;
	});

	it("disarms on blur, and arms again only 700 ms after the focus returns", async () => {
		const asked = make().ask(owner(), prompt);
		await settle();
		const win = latest();
		await open(win);
		await vi.advanceTimersByTimeAsync(700);

		win.emit("blur");
		expect(armCalls(win)).toEqual(["window.arm(true)", "window.arm(false)"]);

		win.emit("focus");
		await vi.advanceTimersByTimeAsync(699);
		expect(armCalls(win)).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(armCalls(win).at(-1)).toBe("window.arm(true)");

		win.close();
		await asked;
	});

	it("doesn't arm if the window loses the focus while it waits", async () => {
		const asked = make().ask(owner(), prompt);
		await settle();
		const win = latest();
		await open(win);

		await vi.advanceTimersByTimeAsync(300);
		win.emit("blur");
		await vi.advanceTimersByTimeAsync(2_000);

		expect(armCalls(win)).toEqual(["window.arm(false)"]);
		win.close();
		await asked;
	});

	it("doesn't arm after the window closed", async () => {
		const asked = make().ask(owner(), prompt);
		await settle();
		const win = latest();
		await open(win);

		win.close();
		await vi.advanceTimersByTimeAsync(2_000);

		expect(armCalls(win)).toEqual([]);
		await asked;
	});
});

describe("the queue", () => {
	it("shows one window at a time, in the order they were asked, across instances", async () => {
		const first = make().ask(owner(), prompt);
		const second = make().ask(owner(), prompt);
		const third = make().ask(owner(), prompt);
		await settle();

		const windows = () => FakeWindow.instances.filter((w) => w.options.webPreferences);
		expect(windows()).toHaveLength(1);

		await open(windows()[0]);
		titled(windows()[0], `${SUBMIT}yes`);
		await expect(first).resolves.toEqual({ shown: true, answer: "yes" });
		await settle();
		expect(windows()).toHaveLength(2);

		await open(windows()[1]);
		windows()[1].close();
		await second;
		await settle();
		expect(windows()).toHaveLength(3);

		windows()[2].close();
		await third;
	});

	it("builds a prompt when its turn comes, so an earlier answer can make it unnecessary", async () => {
		let answeredEarlier = false;
		const first = make().ask(owner(), prompt);
		const second = make().ask(owner(), () => (answeredEarlier ? undefined : prompt()));
		await settle();

		answeredEarlier = true;
		await open(latest());
		latest().close();
		await first;

		await expect(second).resolves.toBeUndefined();
	});

	it("goes on after a window that failed to load", async () => {
		const first = make().ask(owner(), prompt);
		await settle();
		const win = latest();
		win.webContents.emit("did-fail-load");
		await expect(first).resolves.toEqual({ shown: false });

		const second = make().ask(owner(), prompt);
		await settle();
		expect(FakeWindow.instances.filter((w) => w.options.webPreferences)).toHaveLength(2);
		latest().close();
		await second;
	});
});

describe("visibleOwner", () => {
	it("is a window that is there, visible and not minimized", () => {
		const win = owner() as unknown as Fake;
		expect(NativeConfirm.visibleOwner(win as never)).toBe(win);

		win.minimized = true;
		expect(NativeConfirm.visibleOwner(win as never)).toBeUndefined();
		win.minimized = false;
		win.visible = false;
		expect(NativeConfirm.visibleOwner(win as never)).toBeUndefined();
		win.visible = true;
		win.destroyed = true;
		expect(NativeConfirm.visibleOwner(win as never)).toBeUndefined();
		expect(NativeConfirm.visibleOwner(undefined)).toBeUndefined();
	});
});
