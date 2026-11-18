import { Signal } from "@inrixia/helpers";

import { ReactiveStore, type LunaUnloads, type Tracer } from "@luna/core";

import { libTrace, unloads } from "../index.safe";

export interface ShortcutOptions {
	/** Unique id, registering an id again replaces the previous shortcut */
	id: string;
	/**
	 * Default key combination(s), e.g. `"Delete"`, `"Ctrl+Shift+K"` or `["Delete", "Backspace"]`.
	 * Modifiers: `Ctrl`, `Alt`, `Shift`, `Meta`. Key names follow `KeyboardEvent.key`. Users can rebind them in Luna Settings.
	 */
	keys: string | string[];
	/** Human readable description of what the shortcut does, shown in Luna Settings */
	label?: string;
	/** `false` to have it off until the user turns it on in Luna Settings, default `true` */
	enabled?: boolean;
	/** Called when the keys are pressed outside of a text field. Return `false` to let the key through to TIDAL */
	action: (event: KeyboardEvent) => unknown;
}

const modifiers = ["Ctrl", "Alt", "Shift", "Meta"] as const;
const modifierKeys = new Set<string>(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"]);
const textRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const popupRoles = new Set(["menu", "menubar", "listbox", "dialog", "alertdialog"]);
// TIDAL's dialogs are <dialog> elements opened without being modal, focus can be on the dialog itself or outside it
const openDialogSelector = `dialog[open], [aria-modal="true"]`;

// Keys the user rebound and shortcuts they turned on or off in Luna Settings, by shortcut id
const store = ReactiveStore.getStore("@luna/shortcuts");
const userKeys = await store.getReactive<Record<string, string[]>>("keys", {});
const userEnabled = await store.getReactive<Record<string, boolean>>("enabled", {});

export class Shortcut {
	public static readonly trace: Tracer = libTrace.withSource(".Shortcut").trace;
	public static readonly shortcuts: Map<string, Shortcut> = new Map();
	/** Bumped whenever shortcuts are registered, removed, rebound or turned on or off */
	public static readonly version: Signal<number> = new Signal(0);
	private static changed() {
		this.version._ = this.version._ + 1;
	}

	public readonly defaultKeys: string[];
	private constructor(public readonly options: ShortcutOptions) {
		this.defaultKeys = (Array.isArray(options.keys) ? options.keys : [options.keys]).map(Shortcut.normalize);
	}

	public get id() {
		return this.options.id;
	}
	public get label() {
		return this.options.label ?? this.options.id;
	}
	/** The key combinations currently bound, the user's own if they rebound it */
	public get keys(): string[] {
		return userKeys[this.id] ?? this.defaultKeys;
	}
	public get isRebound() {
		return userKeys[this.id] !== undefined;
	}
	/** Whether the shortcut is on, the user's choice if they made one */
	public get enabled(): boolean {
		return userEnabled[this.id] ?? this.options.enabled ?? true;
	}
	/** Turn the shortcut on or off, saved across restarts */
	public setEnabled(enabled: boolean) {
		userEnabled[this.id] = enabled;
		Shortcut.changed();
		this.warnConflicts();
	}
	/**
	 * Rebind this shortcut, `undefined` restores the default keys. Saved across restarts.
	 */
	public setKeys(keys?: string[]) {
		if (keys === undefined) delete userKeys[this.id];
		else userKeys[this.id] = keys.map(Shortcut.normalize);
		Shortcut.changed();
		this.warnConflicts();
	}
	/** Other shortcuts that are on and bound to one of the same key combinations, if this one is on */
	public get conflicts(): Shortcut[] {
		if (!this.enabled) return [];
		return [...Shortcut.shortcuts.values()].filter(
			(other) => other !== this && other.enabled && other.keys.some((keys) => this.keys.includes(keys)),
		);
	}
	private warnConflicts() {
		for (const other of this.conflicts) {
			const keys = other.keys.filter((keys) => this.keys.includes(keys)).join(", ");
			Shortcut.trace.msg.warn(
				`Shortcut "${this.label}" uses ${keys}, which is already used by "${other.label}". Change one of them in Luna Settings.`,
			);
		}
	}

	/**
	 * Register a keyboard shortcut, it is removed again when `unloads` is run.
	 * Warns if one of its keys is already used by another shortcut. The one registered first gets the keys first,
	 * the next one only if its action returns `false`.
	 */
	public static register(unloads: LunaUnloads, options: ShortcutOptions): Shortcut {
		const shortcut = new Shortcut(options);
		this.shortcuts.set(options.id, shortcut);
		this.changed();
		shortcut.warnConflicts();
		unloads.add(() => {
			if (this.shortcuts.get(options.id) !== shortcut) return;
			this.shortcuts.delete(options.id);
			this.changed();
		});
		return shortcut;
	}

	/**
	 * Normalize a key combination to the form used for matching, e.g. `"shift+ctrl+k"` -> `"Ctrl+Shift+K"`
	 */
	public static normalize(keys: string): string {
		// The last part is the key, so "Ctrl++" is Ctrl and "+"
		const parts = keys.split("+");
		let key = parts.pop()!;
		if (key === "" && parts.at(-1) === "") {
			parts.pop();
			key = "+";
		}
		const mods = modifiers.filter((mod) => parts.some((part) => part.toLowerCase() === mod.toLowerCase()));
		if (key.length === 1) key = key.toUpperCase();
		return [...mods, key].join("+");
	}

	/**
	 * The key combination of `event`, e.g. `"Ctrl+Shift+K"`. `undefined` if only modifiers are pressed
	 */
	public static fromEvent(event: KeyboardEvent): string | undefined {
		if (modifierKeys.has(event.key)) return;
		const mods = modifiers.filter((mod) => event[`${mod.toLowerCase() as Lowercase<typeof mod>}Key`]);
		let key = event.key === " " ? "Space" : event.key;
		// Letters of non-Latin layouts (e.g. "я" on the Z key of a Russian layout) count as the Latin letter of the same key,
		// so shortcuts work whatever layout is active
		const latin = /^Key([A-Z])$/.exec(event.code)?.[1];
		if (latin !== undefined && key.length === 1 && !/[a-z]/i.test(key) && key.toLowerCase() !== key.toUpperCase()) key = latin;
		return this.normalize([...mods, key].join("+"));
	}

	/**
	 * True if `event` is exactly the key combination `keys`
	 */
	public static matches(event: KeyboardEvent, keys: string): boolean {
		return this.fromEvent(event) === this.normalize(keys);
	}

	/**
	 * True if the event comes from a text field, shortcuts are ignored while typing.
	 * Looks through shadow DOM and covers inputs, textareas, selects, contenteditable and ARIA text boxes.
	 */
	public static isTyping(event: Event): boolean {
		for (const target of event.composedPath()) {
			if (!(target instanceof HTMLElement)) continue;
			if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
			if (textRoles.has(target.getAttribute("role") ?? "")) return true;
		}
		return false;
	}

	/**
	 * True if a dialog is open or the event comes from a menu, e.g. TIDAL's context menu.
	 * Their keys belong to them, not to the page behind them.
	 */
	public static isInPopup(event: Event): boolean {
		if (document.querySelector(openDialogSelector) !== null) return true;
		return event.composedPath().some((target) => target instanceof HTMLElement && popupRoles.has(target.getAttribute("role") ?? ""));
	}
}

const onKeyDown = (event: KeyboardEvent) => {
	if (event.defaultPrevented || event.repeat || Shortcut.isTyping(event) || Shortcut.isInPopup(event)) return;
	const keys = Shortcut.fromEvent(event);
	if (keys === undefined) return;
	for (const shortcut of Shortcut.shortcuts.values()) {
		if (!shortcut.enabled || !shortcut.keys.includes(keys)) continue;
		const onError = Shortcut.trace.msg.err.withContext(shortcut.id);
		try {
			const result = shortcut.options.action(event);
			if (result === false) continue;
			if (result instanceof Promise) result.catch(onError);
		} catch (err) {
			onError(err);
		}
		event.preventDefault();
		event.stopPropagation();
		return;
	}
};
document.addEventListener("keydown", onKeyDown, { capture: true });
unloads.add(() => document.removeEventListener("keydown", onKeyDown, { capture: true }));
