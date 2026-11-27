// Fixes for performance bugs in TIDAL's bundled code, applied to each module's source as it loads (tidalTransform.ts).
// Patterns are tied to library source shapes, not minified names. A patch that stops matching after a TIDAL update is skipped.

export type Patch = { name: string; marker: string; find: RegExp; replace: string };

// Exported so a check can ask which of these still match the code TIDAL ships (see tidalPatchCheck.ts)
export const tidalPatches: Patch[] = [
	{
		// react-dnd: a ref callback that changes every render calls the drag source hook with null and then the same node.
		// The null disconnects (draggable="false") and the node reconnects (draggable="true"), so every re-rendered card invalidates style.
		// Disconnect on null after the commit instead, by when the same node is usually back and nothing changes.
		name: "react-dnd dragSource ref churn",
		marker: "dragSource:(",
		find: /(dragSource:\(([\w$]+),[\w$]+\)=>\{this\.clearDragSource\(\),[^{}]*?)this\.reconnectDragSource\(\)\}/,
		replace: "$1$2?this.reconnectDragSource():queueMicrotask(()=>this.reconnectDragSource())}",
	},
	{
		// react-intersection-observer useInView: with triggerOnce, any option change (TIDAL's rootMargin follows playbackState) observes the
		// element again and fires onChange again, e.g. a homepage/TRACK_ITEM dispatch per visible item on every track change.
		name: "react-intersection-observer triggerOnce re-observe",
		marker: "triggerOnce:",
		find:
			/(\{threshold:[\w$]+,delay:[\w$]+,trackVisibility:[\w$]+,rootMargin:[\w$]+,root:[\w$]+,triggerOnce:([\w$]+),[^]{0,300}?\.useEffect\(\(\)=>\{if\(([\w$]+)\.current===void 0&&\(\3\.current=[\w$]+\),[\w$]+\|\|![\w$]+)\)return;/,
		replace: "$1||$2&&$3.current)return;",
	},
	{
		// overlayscrollbars-react useOverlayScrollbars: initialise native scrolling (nativeScrollbars.ts) instead of an OverlayScrollbars instance
		name: "OverlayScrollbars to native scrolling",
		marker: "data-overlayscrollbars-initialize",
		find: /(=>\{let ([\w$]+)=([\w$]+)\.current;if\(([\w$]+)\.valid\(\2\)\)return;let [^;]{0,160}?=\(\)=>\3\.current=)\4\(/,
		replace: "$1globalThis.__lunaNativeScroll(",
	},
];

// Per module, no state, so the same source always gives the same output
export const applyTidalPatches = (code: string) => {
	for (const patch of tidalPatches) if (code.includes(patch.marker)) code = code.replace(patch.find, patch.replace);
	return code;
};
