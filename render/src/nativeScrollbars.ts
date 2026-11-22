// Stands in for TIDAL's OverlayScrollbars instances (see tidalPatches.ts). OverlayScrollbars measures and restyles its host on every
// navigation, ~100ms of forced style recalcs on heavy pages. The host scrolls natively instead, with a styled native scrollbar.
// OverlayScrollbars' own css already makes an uninitialised host scroll natively (its scrollbar hidden), so only the scrollbar is shown here.

type Listener = (...args: unknown[]) => void;
type Events = Record<string, Listener | Listener[] | undefined>;
type Options = { overflow?: { x?: string; y?: string } };

// Looks like os-theme-tidal: 10px, 2px inset, round thumb shown while the pointer is over the area.
// The :not(#_) beats OverlayScrollbars' !important hiding and TIDAL's .enable-scrollbar-styles track and thumb
const css = `
[data-luna-scroll]:not(#_) { scrollbar-width: auto !important; }
[data-luna-scroll]:not(#_)::-webkit-scrollbar { display: block !important; width: 10px !important; height: 10px !important; max-width: none; max-height: none; background: transparent; }
[data-luna-scroll]:not(#_)::-webkit-scrollbar-track, [data-luna-scroll]:not(#_)::-webkit-scrollbar-corner { display: block !important; background: transparent; }
[data-luna-scroll]:not(#_)::-webkit-scrollbar-thumb { border: 2px solid transparent; background: transparent padding-box; border-radius: var(--market-core-radius-66, 999px); min-width: 40px; min-height: 40px; }
@property --luna-scroll-hover { syntax: "*"; inherits: false; }
/* Chrome only restyles the scrollbar when the scroller's own style changes, a non-inherited one so its children aren't restyled */
[data-luna-scroll]:hover { --luna-scroll-hover: 1; }
[data-luna-scroll]:not(#_):hover::-webkit-scrollbar-thumb { background-color: var(--market-core-fill-20-color); }
[data-luna-scroll]:not(#_)::-webkit-scrollbar-thumb:hover { background-color: var(--market-core-text-20-color); }
[data-luna-scroll]:not(#_)::-webkit-scrollbar-thumb:active { background-color: var(--market-core-fill-10-color); }
`;

const emit = (events: Events | undefined, name: string, ...args: unknown[]) => {
	for (const listener of [events?.[name]].flat()) if (typeof listener === "function") listener(...args);
};
const overflow = (axis?: string) => (axis === undefined || axis.endsWith("scroll") ? "auto" : "hidden");

const instances = new WeakMap<Element, object>();
let styled = false;
/** Takes OverlayScrollbars' (target, options, events) and returns the parts of an instance TIDAL uses, with every element being the target */
const nativeScroll = (init: Element | { target: Element }, options?: Options, events?: Events) => {
	const target = <HTMLElement>(init instanceof Element ? init : init.target);
	const existing = instances.get(target);
	if (existing !== undefined) return existing;
	if (!styled) {
		styled = true;
		const style = document.createElement("style");
		style.id = "luna-native-scrollbars";
		style.textContent = css;
		document.head.append(style);
	}

	target.setAttribute("data-luna-scroll", "");
	target.style.overflowX = overflow(options?.overflow?.x);
	target.style.overflowY = overflow(options?.overflow?.y);

	let destroyed = false;
	const elements = {
		target,
		host: target,
		padding: target,
		viewport: target,
		content: target,
		scrollOffsetElement: target,
		scrollEventElement: target,
	};
	const onScroll = (event: Event) => emit(events, "scroll", instance, event);
	target.addEventListener("scroll", onScroll, { passive: true });
	// TIDAL's fading scroll areas recompute their edges on updated, fires once on observe too
	const resizeObserver = events?.updated !== undefined ? new ResizeObserver(() => emit(events, "updated", instance, {})) : undefined;
	resizeObserver?.observe(target);

	const instance = {
		options: () => options ?? {},
		elements: () => elements,
		state: () => ({ destroyed }),
		update: () => false,
		on: () => () => {},
		off: () => {},
		plugin: () => undefined,
		destroy() {
			if (destroyed) return;
			destroyed = true;
			target.removeEventListener("scroll", onScroll);
			resizeObserver?.disconnect();
			target.removeAttribute("data-luna-scroll");
			target.style.overflowX = target.style.overflowY = "";
			instances.delete(target);
			emit(events, "destroyed", instance, false);
		},
	};
	instances.set(target, instance);
	queueMicrotask(() => emit(events, "initialized", instance));
	return instance;
};

(<{ __lunaNativeScroll?: typeof nativeScroll }>globalThis).__lunaNativeScroll = nativeScroll;
