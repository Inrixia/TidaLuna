// based on: https://github.com/KaiHax/kaihax/blob/master/src/patcher.ts

import type { VoidFn } from "@inrixia/helpers";
import type { LunaUnloads } from "@luna/core";
import { unloads } from "../index.safe";
import { safeTimeout } from "./safeTimeout";

export type ObserveCallback<E extends Element = Element> = (elem: E) => unknown;
export type ObserveEntry<E extends Element = Element> = [selector: string, callback: ObserveCallback<E>];
const observables = new Set<ObserveEntry>();
const observer = new MutationObserver((records) => {
	if (observables.size === 0) return;

	// Only scan nodes added in this batch. Elements that were already in the DOM were reported when they were added,
	// re-scanning the whole subtree of every mutation target re-fired callbacks for them on any unrelated change.
	const added: Element[] = [];
	for (const record of records) {
		for (const node of record.addedNodes) {
			// Skip nodes that were removed again in the same batch
			if (node.nodeType === Node.ELEMENT_NODE && node.isConnected) added.push(<Element>node);
		}
	}
	if (added.length === 0) return;

	for (const obs of observables) {
		const sel = obs[0];
		const cb = obs[1];
		// A Set so an element added with one of its ancestors in the same batch is only reported once
		const matched = new Set<Element>();
		for (const elem of added) {
			if (elem.matches(sel)) matched.add(elem);
			if (elem.firstElementChild !== null) for (const el of elem.querySelectorAll(sel)) matched.add(el);
		}
		for (const el of matched) cb(el);
	}
});

/**
 * Observes the DOM for elements matching the given selector and calls the callback when they appear.
 * Elements already in the DOM are reported once, right after this call.
 * @param selector The CSS selector to observe.
 * @param cb The callback function to execute when a matching element is found cast to type T.
 * @returns An `Unload` function that, when called, will stop observing for this selector and callback pair.
 */
export const observe = <T extends Element = Element>(unloads: LunaUnloads, selector: string, cb: ObserveCallback<T>): VoidFn => {
	if (observables.size === 0)
		observer.observe(document.body, {
			subtree: true,
			childList: true,
		});
	const entry: ObserveEntry = [selector, cb as ObserveCallback<Element>];
	observables.add(entry);
	// Report elements that are already in the DOM, as they will not show up as added nodes
	queueMicrotask(() => {
		for (const el of document.querySelectorAll(selector)) {
			if (!observables.has(entry)) return;
			entry[1](el);
		}
	});
	const unload = () => {
		observables.delete(entry);
		if (observables.size === 0) observer.disconnect();
	};
	unloads.add(unload);
	return unload;
};

// Disconnect and remove observables on unload
unloads.add(observer.disconnect.bind(observer));
unloads.add(observables.clear.bind(observables));

/**
 * Observes the DOM for an element matching the given selector and returns a Promise that resolves with the element when found.
 * If the element is not found within the specified timeout (default 1000ms), the Promise resolves with null.
 * @param selector The CSS selector to observe.
 * @param timeoutMs The maximum time (in milliseconds) to wait for the element to appear.
 * @returns A Promise that resolves with the found Element (cast to type T) or null if the timeout is reached.
 */
export const observePromise = <T extends Element>(unloads: LunaUnloads, selector: string, timeoutMs: number = 1000): Promise<T | null> =>
	new Promise<T | null>((res) => {
		const elem = document.querySelector(selector);
		if (elem !== null) res(elem as T);
		const unob = observe(unloads, selector, (elem) => {
			unob();
			timeout();
			res(elem as T);
		});
		const timeout = safeTimeout(
			unloads,
			() => {
				unob();
				res(null);
			},
			timeoutMs,
		);
	});
