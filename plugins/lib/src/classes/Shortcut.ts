import type { LunaUnloads, Tracer } from "@luna/core";

import { libTrace, unloads } from "../index.safe";

export interface ShortcutOptions {
	/** Unique id, registering an id again replaces the previous shortcut */
	id: string;
	/** Key combination, e.g. `"Delete"`, `"Ctrl+Shift+K"`. Modifiers: `Ctrl`, `Alt`, `Shift`, `Meta`. Key names follow `KeyboardEvent.key` */
	keys: string;
	/** Human readable description of what the shortcut does */
	label?: string;
	/** Called when the keys are pressed outside of a text field. Return `false` to let the key through to TIDAL */
	action: (event: KeyboardEvent) => unknown;
}

const modifiers = ["ctrl", "alt", "shift", "meta"] as const;

export class Shortcut {
	public static readonly trace: Tracer = libTrace.withSource(".Shortcut").trace;
	public static readonly shortcuts: Map<string, Shortcut> = new Map();

	private constructor(public readonly options: ShortcutOptions) {}

	/**
	 * Register a keyboard shortcut, it is removed again when `unloads` is run
	 */
	public static register(unloads: LunaUnloads, options: ShortcutOptions): Shortcut {
		const shortcut = new Shortcut(options);
		this.shortcuts.set(options.id, shortcut);
		unloads.add(() => {
			if (this.shortcuts.get(options.id) === shortcut) this.shortcuts.delete(options.id);
		});
		return shortcut;
	}

	/**
	 * True if `event` is exactly the key combination `keys`
	 */
	public static matches(event: KeyboardEvent, keys: string): boolean {
		const parts = keys.toLowerCase().split("+");
		const key = parts.pop();
		if (key === undefined || event.key.toLowerCase() !== key) return false;
		return modifiers.every((mod) => parts.includes(mod) === event[`${mod}Key`]);
	}

	/**
	 * True if `target` is a text field, shortcuts are ignored while typing
	 */
	public static isTyping(target: EventTarget | null) {
		if (!(target instanceof HTMLElement)) return false;
		return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
	}
}

const onKeyDown = (event: KeyboardEvent) => {
	if (event.defaultPrevented || event.repeat || Shortcut.isTyping(event.target)) return;
	for (const { options } of Shortcut.shortcuts.values()) {
		if (!Shortcut.matches(event, options.keys)) continue;
		const onError = Shortcut.trace.msg.err.withContext(options.id);
		try {
			const result = options.action(event);
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
