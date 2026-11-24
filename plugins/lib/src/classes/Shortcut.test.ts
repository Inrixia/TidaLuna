import { unloadSet, type LunaUnload } from "@luna/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Shortcut, type ShortcutOptions } from "./Shortcut";

/**
 * Shortcuts registered by a test are removed again after it, so one test's action can't answer a later test's key press.
 * `Shortcut` matches every registered shortcut, so tests also use their own key combinations.
 */
const unloads = new Set<LunaUnload>();
afterEach(async () => {
	await unloadSet(unloads);
});

const options = (id: string, keys: string | string[], extra: Partial<ShortcutOptions> = {}): ShortcutOptions => ({
	id,
	keys,
	action: () => {},
	...extra,
});
const register = (id: string, keys: string | string[], extra: Partial<ShortcutOptions> = {}) =>
	Shortcut.register(unloads, options(id, keys, extra));

type PressInit = KeyboardEventInit & { repeat?: boolean };
/** Presses keys like the page does: the event has to bubble for `Shortcut`'s capture listener on `document` to see it */
const press = (init: PressInit = {}, target: Element = document.body) => {
	const event = new KeyboardEvent("keydown", { key: "k", code: "KeyK", bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
};
/** A keydown event `Shortcut.fromEvent` is given directly, for the key combination tests */
const keyEvent = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("normalize", () => {
	test("puts the modifiers in a fixed order and uppercases a single character key", () => {
		expect(Shortcut.normalize("shift+ctrl+k")).toBe("Ctrl+Shift+K");
		expect(Shortcut.normalize("alt+meta+ctrl+shift+x")).toBe("Ctrl+Alt+Shift+Meta+X");
	});

	test("leaves multi character keys alone", () => {
		expect(Shortcut.normalize("Delete")).toBe("Delete");
		expect(Shortcut.normalize("ctrl+ArrowDown")).toBe("Ctrl+ArrowDown");
	});

	test("keeps + as a key of its own", () => {
		expect(Shortcut.normalize("Ctrl++")).toBe("Ctrl++");
		expect(Shortcut.normalize("+")).toBe("+");
	});
});

describe("fromEvent", () => {
	test("is the modifiers and key of the event", () => {
		expect(Shortcut.fromEvent(keyEvent({ key: "k", code: "KeyK", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+K");
		expect(Shortcut.fromEvent(keyEvent({ key: "ArrowDown", altKey: true }))).toBe("Alt+ArrowDown");
		expect(Shortcut.fromEvent(keyEvent({ key: "Delete", metaKey: true }))).toBe("Meta+Delete");
	});

	test("is Space for the space bar", () => {
		expect(Shortcut.fromEvent(keyEvent({ key: " " }))).toBe("Space");
	});

	test("is undefined for a modifier on its own", () => {
		expect(Shortcut.fromEvent(keyEvent({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeUndefined();
		expect(Shortcut.fromEvent(keyEvent({ key: "Shift", code: "ShiftLeft", shiftKey: true }))).toBeUndefined();
	});

	test("counts a letter of a non-Latin layout as the Latin letter of the same key", () => {
		// "я" is the Z key of a Russian layout
		expect(Shortcut.fromEvent(keyEvent({ key: "я", code: "KeyZ" }))).toBe("Z");
	});
});

describe("matches", () => {
	test("matches the same combination written differently", () => {
		expect(Shortcut.matches(keyEvent({ key: "k", code: "KeyK", ctrlKey: true }), "ctrl+k")).toBe(true);
		expect(Shortcut.matches(keyEvent({ key: "k", code: "KeyK", ctrlKey: true }), "shift+k")).toBe(false);
	});

	test("does not match a modifier on its own", () => {
		expect(Shortcut.matches(keyEvent({ key: "Control", ctrlKey: true }), "Ctrl")).toBe(false);
	});
});

describe("register", () => {
	test("adds the shortcut to the lookup", () => {
		const shortcut = register("shortcut-test-register", "Ctrl+Alt+F8");

		expect(Shortcut.shortcuts.get("shortcut-test-register")).toBe(shortcut);
		expect(shortcut.id).toBe("shortcut-test-register");
		expect(shortcut.label).toBe("shortcut-test-register");
		expect(shortcut.defaultKeys).toEqual(["Ctrl+Alt+F8"]);
		expect(shortcut.keys).toEqual(["Ctrl+Alt+F8"]);
		expect(shortcut.isRebound).toBe(false);
		expect(shortcut.enabled).toBe(true);
	});

	test("takes a label and a starting enabled state", () => {
		const shortcut = register("shortcut-test-label", "Ctrl+Alt+F8", { label: "Do the thing", enabled: false });

		expect(shortcut.label).toBe("Do the thing");
		expect(shortcut.enabled).toBe(false);
	});

	test("takes several key combinations, normalized", () => {
		const shortcut = register("shortcut-test-combos", ["delete", "ctrl+k"]);

		// Only single character keys are uppercased, multi character keys are matched as `KeyboardEvent.key` gives them
		expect(shortcut.defaultKeys).toEqual(["delete", "Ctrl+K"]);
	});

	test("registering an id again replaces the previous shortcut", async () => {
		const firstUnloads = new Set<LunaUnload>();
		const secondUnloads = new Set<LunaUnload>();
		const first = Shortcut.register(firstUnloads, options("shortcut-test-replace", "Ctrl+Alt+F7"));
		const second = Shortcut.register(secondUnloads, options("shortcut-test-replace", "Ctrl+Alt+F6"));

		expect(Shortcut.shortcuts.get("shortcut-test-replace")).toBe(second);

		// Unloading the replaced shortcut must not remove the one that replaced it
		await unloadSet(firstUnloads);
		expect(Shortcut.shortcuts.get("shortcut-test-replace")).toBe(second);

		await unloadSet(secondUnloads);
		expect(Shortcut.shortcuts.get("shortcut-test-replace")).toBeUndefined();
		expect(Shortcut.shortcuts.get("shortcut-test-replace")).not.toBe(first);
	});

	test("removes the shortcut when its unloads are run", async () => {
		const action = vi.fn();
		register("shortcut-test-unload", "Ctrl+Alt+F8", { action });

		await unloadSet(unloads);
		const event = press({ key: "F8", code: "F8", ctrlKey: true, altKey: true });

		expect(Shortcut.shortcuts.get("shortcut-test-unload")).toBeUndefined();
		expect(action).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	test("bumps the version when shortcuts are registered and removed", async () => {
		const version = Shortcut.version._;

		register("shortcut-test-version", "Ctrl+Alt+F8");
		expect(Shortcut.version._).toBe(version + 1);

		await unloadSet(unloads);
		expect(Shortcut.version._).toBe(version + 2);
	});
});

describe("key presses", () => {
	test("runs the action and consumes the key", () => {
		const action = vi.fn();
		register("shortcut-test-press", "Ctrl+Shift+F6", { action });

		const event = press({ key: "F6", code: "F6", ctrlKey: true, shiftKey: true });

		expect(action).toHaveBeenCalledTimes(1);
		expect(action.mock.calls[0][0]).toBe(event);
		expect(event.defaultPrevented).toBe(true);
	});

	test("does not run a shortcut the user turned off", () => {
		const action = vi.fn();
		register("shortcut-test-off", "Ctrl+Shift+F5", { action }).setEnabled(false);

		const event = press({ key: "F5", code: "F5", ctrlKey: true, shiftKey: true });

		expect(action).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	test("runs a turned off shortcut again once it is turned on", () => {
		const action = vi.fn();
		const shortcut = register("shortcut-test-on-again", "Ctrl+Shift+F4", { action });
		shortcut.setEnabled(false);
		shortcut.setEnabled(true);

		press({ key: "F4", code: "F4", ctrlKey: true, shiftKey: true });

		expect(action).toHaveBeenCalledTimes(1);
		expect(shortcut.enabled).toBe(true);
	});

	test("ignores keys typed in a text field", () => {
		const action = vi.fn();
		register("shortcut-test-typing", "Ctrl+Shift+F3", { action });
		const input = document.createElement("input");
		document.body.append(input);

		const event = press({ key: "F3", code: "F3", ctrlKey: true, shiftKey: true }, input);
		input.remove();

		expect(action).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	test("ignores keys pressed in a menu", () => {
		const action = vi.fn();
		register("shortcut-test-menu", "Ctrl+Shift+F2", { action });
		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		document.body.append(menu);

		const event = press({ key: "F2", code: "F2", ctrlKey: true, shiftKey: true }, menu);
		menu.remove();

		expect(action).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	test("ignores a modifier pressed on its own", () => {
		const action = vi.fn();
		register("shortcut-test-modifier", "Ctrl+Shift+F1", { action });

		const event = press({ key: "Control", code: "ControlLeft", ctrlKey: true });

		expect(action).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	test("ignores repeated keys", () => {
		const action = vi.fn();
		register("shortcut-test-repeat", "Ctrl+Shift+F10", { action });

		press({ key: "F10", code: "F10", ctrlKey: true, shiftKey: true, repeat: true });

		expect(action).not.toHaveBeenCalled();
	});

	test("ignores keys something else already handled", () => {
		const action = vi.fn();
		register("shortcut-test-handled", "Ctrl+Shift+F11", { action });

		const event = new KeyboardEvent("keydown", { key: "F11", code: "F11", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
		event.preventDefault();
		document.body.dispatchEvent(event);

		expect(action).not.toHaveBeenCalled();
	});

	test("the shortcut registered first gets the keys, the next one only if its action returns false", () => {
		const first = vi.fn(() => false);
		const second = vi.fn();
		register("shortcut-test-order-a", "Ctrl+Alt+F2", { action: first });
		register("shortcut-test-order-b", "Ctrl+Alt+F2", { action: second });

		const event = press({ key: "F2", code: "F2", ctrlKey: true, altKey: true });

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	test("stops the key from reaching the page when a shortcut handles it", () => {
		const action = vi.fn();
		const pageListener = vi.fn();
		register("shortcut-test-stop", "Ctrl+Alt+F9", { action });
		document.body.addEventListener("keydown", pageListener);

		const event = press({ key: "F9", code: "F9", ctrlKey: true, altKey: true });
		document.body.removeEventListener("keydown", pageListener);

		expect(action).toHaveBeenCalledTimes(1);
		expect(pageListener).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(true);
	});

	test("lets the key through when every matching action returns false", () => {
		register("shortcut-test-pass-through", "Ctrl+Alt+F12", { action: () => false });

		const event = press({ key: "F12", code: "F12", ctrlKey: true, altKey: true });

		expect(event.defaultPrevented).toBe(false);
	});
});

describe("user bindings", () => {
	test("setKeys rebinds the shortcut", () => {
		const action = vi.fn();
		const shortcut = register("shortcut-test-rebind", "Delete", { action });

		shortcut.setKeys(["ctrl+k"]);

		expect(shortcut.keys).toEqual(["Ctrl+K"]);
		expect(shortcut.isRebound).toBe(true);
		// The default keys are no longer bound
		const oldKeys = press({ key: "Delete" });
		const newKeys = press({ key: "k", code: "KeyK", ctrlKey: true });
		expect(action).toHaveBeenCalledTimes(1);
		expect(newKeys.defaultPrevented).toBe(true);
		expect(oldKeys.defaultPrevented).toBe(false);
	});

	test("setKeys without keys restores the default bindings", () => {
		const shortcut = register("shortcut-test-restore-keys", "Delete");

		shortcut.setKeys(["ctrl+k"]);
		shortcut.setKeys();

		expect(shortcut.keys).toEqual(["Delete"]);
		expect(shortcut.isRebound).toBe(false);
	});

	test("setEnabled and setKeys bump the version", () => {
		const shortcut = register("shortcut-test-binding-version", "Ctrl+Alt+F8");
		const version = Shortcut.version._;

		shortcut.setEnabled(false);
		expect(Shortcut.version._).toBe(version + 1);

		shortcut.setKeys(["ctrl+k"]);
		expect(Shortcut.version._).toBe(version + 2);
	});
});

describe("conflicts", () => {
	test("lists the other shortcuts that are on and bound to the same keys", () => {
		const first = register("shortcut-test-conflict-a", "Ctrl+Alt+F6");
		const second = register("shortcut-test-conflict-b", "alt+ctrl+F6");

		expect(first.conflicts).toEqual([second]);
		expect(second.conflicts).toEqual([first]);
	});

	test("has no conflicts for different keys", () => {
		register("shortcut-test-conflict-c", "Ctrl+Alt+F7");
		const other = register("shortcut-test-conflict-d", "Ctrl+Alt+F5");

		expect(other.conflicts).toEqual([]);
	});

	test("does not conflict with a turned off shortcut", () => {
		const first = register("shortcut-test-conflict-e", "Ctrl+Alt+F4");
		const second = register("shortcut-test-conflict-f", "Ctrl+Alt+F4", { enabled: false });

		expect(first.conflicts).toEqual([]);

		second.setEnabled(true);
		expect(first.conflicts).toEqual([second]);
	});

	test("a turned off shortcut has no conflicts of its own", () => {
		register("shortcut-test-conflict-g", "Ctrl+Alt+F3");
		const off = register("shortcut-test-conflict-h", "Ctrl+Alt+F3");

		off.setEnabled(false);

		expect(off.conflicts).toEqual([]);
	});
});
