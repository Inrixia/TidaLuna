// Fixes for performance bugs in TIDAL's bundled code, applied to each module's source as quartz loads it.
// Patterns are tied to library source shapes, not minified names. A patch that stops matching after a TIDAL update is skipped.
type Patch = { name: string; marker: string; find: RegExp; replace: string };

const patches: Patch[] = [
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
];

const applied = new Set<string>();
export const applyTidalPatches = (code: string) => {
	for (const patch of patches) {
		if (applied.has(patch.name) || !code.includes(patch.marker)) continue;
		const patched = code.replace(patch.find, patch.replace);
		if (patched === code) continue;
		applied.add(patch.name);
		code = patched;
	}
	return code;
};
