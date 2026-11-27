// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * native/preload.ts runs in TIDAL's page, ahead of its code, with Electron's `contextBridge` and `ipcRenderer`. It is
 * imported here against stand-ins for both: the channel filter and the user-input events are the parts that carry
 * the confirmation window's trust (see native/core/confirmPage.ts).
 */
const electron = vi.hoisted(() => ({
	ipcRenderer: {
		on: vi.fn(),
		once: vi.fn(),
		removeListener: vi.fn(),
		invoke: vi.fn(async () => undefined),
		send: vi.fn(),
	},
	contextBridge: { exposeInMainWorld: vi.fn() },
	webFrame: { executeJavaScript: vi.fn(async () => undefined) },
}));
vi.mock("electron", () => electron);

type Bridge = {
	invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
	send: (channel: string, ...args: unknown[]) => void;
};
const page = globalThis as unknown as { __ipcRenderer?: Bridge; __platform?: string };

let now = 0;
const loadPreload = async (url: string, contextIsolated?: boolean) => {
	(window as any).happyDOM.setURL(url);
	(process as any).contextIsolated = contextIsolated;
	vi.resetModules();
	await import("./preload");
	await Promise.resolve();
};
/** A click or key the way the browser reports one from the user: only those have `isTrusted` */
const userEvent = (type: string, trusted: boolean) => {
	const event = new Event(type, { bubbles: true });
	Object.defineProperty(event, "isTrusted", { value: trusted });
	window.dispatchEvent(event);
};
/**
 * happy-dom reports its own inner object as the target of an event sent to the window, not `window`, which a browser
 * does: the listener the preload added is called with the event the browser would give it
 */
const blurOf = (target: unknown, isTrusted: boolean) => {
	const listener = listeners.find(([type]) => type === "blur")![1] as (event: unknown) => void;
	listener({ isTrusted, target });
};
const userInputSent = () => electron.ipcRenderer.send.mock.calls.filter(([channel]) => channel === "__Luna.userInput").map(([, value]) => value);

const listeners: [string, EventListenerOrEventListenerObject, AddEventListenerOptions | undefined][] = [];
describe("preload", () => {
	const realAdd = window.addEventListener.bind(window);
	beforeEach(() => {
		vi.clearAllMocks();
		now = 10_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		// Every import of the preload adds its listeners to the one window: they are taken off between tests
		vi.spyOn(window, "addEventListener").mockImplementation((type: string, listener: any, options?: any) => {
			listeners.push([type, listener, options]);
			realAdd(type, listener, options);
		});
		delete page.__ipcRenderer;
		delete page.__platform;
	});
	afterEach(() => {
		for (const [type, listener, options] of listeners.splice(0)) window.removeEventListener(type, listener, options);
		vi.restoreAllMocks();
		delete (process as any).contextIsolated;
	});

	describe("the page's IPC bridge", () => {
		it("refuses the channel only the preload may send, for invoke and send", async () => {
			await loadPreload("https://listen.tidal.com/");
			const bridge = page.__ipcRenderer!;
			await expect(bridge.invoke("__Luna.userInput", true)).rejects.toThrow("Channel __Luna.userInput is not available to the page");
			expect(() => bridge.send("__Luna.userInput", true)).toThrow("Channel __Luna.userInput is not available to the page");
			expect(electron.ipcRenderer.invoke).not.toHaveBeenCalledWith("__Luna.userInput", expect.anything());
			expect(userInputSent()).toEqual([]);
		});

		it("passes the channels the page needs and refuses every other", async () => {
			await loadPreload("https://listen.tidal.com/");
			const bridge = page.__ipcRenderer!;
			await bridge.invoke("__Luna.getSeedSettings", 1);
			await bridge.invoke("__LunaNative.some.native.ts", 2);
			bridge.send("update-info", 3);
			expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith("__Luna.getSeedSettings", 1);
			expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith("__LunaNative.some.native.ts", 2);
			expect(electron.ipcRenderer.send).toHaveBeenCalledWith("update-info", 3);

			vi.clearAllMocks();
			await expect(bridge.invoke("__Luna.renderJs")).rejects.toThrow("is not available to the page");
			expect(() => bridge.send("__Luna.something", 4)).toThrow("is not available to the page");
			expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
			expect(electron.ipcRenderer.send).not.toHaveBeenCalled();
		});

		it("is exposed through contextBridge when the page is isolated, and on the window when it is not", async () => {
			await loadPreload("https://listen.tidal.com/", true);
			expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith("__ipcRenderer", expect.any(Object));
			expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith("__platform", process.platform);
			expect(page.__ipcRenderer).toBeUndefined();

			vi.clearAllMocks();
			await loadPreload("https://listen.tidal.com/", false);
			expect(electron.contextBridge.exposeInMainWorld).not.toHaveBeenCalled();
			expect(page.__ipcRenderer).toBeDefined();
			expect(page.__platform).toBe(process.platform);
		});

		it("is not given to a page that is not TIDAL's", async () => {
			await loadPreload("https://example.com/");
			expect(page.__ipcRenderer).toBeUndefined();
			expect(page.__platform).toBe(process.platform);
			userEvent("pointerdown", true);
			expect(userInputSent()).toEqual([]);
			expect(electron.webFrame.executeJavaScript).not.toHaveBeenCalled();
		});

		it("is not given to a TIDAL host over http", async () => {
			await loadPreload("http://listen.tidal.com/");
			expect(page.__ipcRenderer).toBeUndefined();
		});
	});

	describe("user input", () => {
		it("a trusted click or key tells the main process, at most once a second", async () => {
			await loadPreload("https://listen.tidal.com/");
			userEvent("pointerdown", true);
			userEvent("keydown", true);
			expect(userInputSent()).toEqual([true]);
			now += 999;
			userEvent("pointerdown", true);
			expect(userInputSent()).toEqual([true]);
			now += 2;
			userEvent("keydown", true);
			expect(userInputSent()).toEqual([true, true]);
		});

		it("an event the page's own code made is not input", async () => {
			await loadPreload("https://listen.tidal.com/");
			userEvent("pointerdown", false);
			userEvent("keydown", false);
			expect(userInputSent()).toEqual([]);
			blurOf(window, false);
			expect(userInputSent()).toEqual([]);
		});

		it("leaving TIDAL tells the main process, and the next input is not held back by the rate limit", async () => {
			await loadPreload("https://listen.tidal.com/");
			userEvent("pointerdown", true);
			blurOf(window, true);
			userEvent("pointerdown", true);
			expect(userInputSent()).toEqual([true, false, true]);
		});

		it("a blur of an element inside the page is not leaving TIDAL", async () => {
			await loadPreload("https://listen.tidal.com/");
			blurOf(document.createElement("input"), true);
			expect(userInputSent()).toEqual([]);
		});
	});

	it("forwards the main process's console messages to the page", async () => {
		await loadPreload("https://listen.tidal.com/");
		const [, forward] = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === "__Luna.console")!;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		(forward as (...args: unknown[]) => void)({}, "log", ["from main"]);
		expect(log).toHaveBeenCalledWith("from main");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		(forward as (...args: unknown[]) => void)({}, "nope", ["x"]);
		expect(error).toHaveBeenCalledWith("[Luna.native]", "Failed to forward console to renderer", expect.any(Error), ["x"]);
	});
});
