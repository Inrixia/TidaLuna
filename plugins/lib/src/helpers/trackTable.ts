type Fiber = {
	memoizedProps?: Record<string, unknown>;
	return?: Fiber | null;
	alternate?: Fiber | null;
	tag?: number;
	stateNode?: { current?: Fiber };
};
// React keeps two copies of each fiber and the one a DOM node points to may be the previous render's, whose getters
// return the previous selection. The current copy is the one that leads up to the root's current fiber.
const isCurrent = (fiber: Fiber) => {
	while (fiber.return) fiber = fiber.return;
	return fiber.tag === 3 && fiber.stateNode?.current === fiber;
};

/**
 * The props TIDAL's track table passes down to `row` that have `getter` as a function, from React's current render.
 * TIDAL keeps a table's selection in its React state and passes getters for it down to every row.
 */
export const trackTableProps = <P extends object>(row: Element, getter: keyof P & string): P | undefined => {
	const fiberKey = Object.keys(row).find((key) => key.startsWith("__reactFiber$"));
	let fiber = fiberKey && (<Record<string, Fiber | undefined>>(<unknown>row))[fiberKey];
	for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return ?? undefined) {
		if (typeof fiber.memoizedProps?.[getter] !== "function") continue;
		const current = isCurrent(fiber) ? fiber : fiber.alternate;
		if (typeof current?.memoizedProps?.[getter] === "function") return <P>current.memoizedProps;
		return;
	}
};

/** The track list rows on the page, without the rows of suggested tracks under a playlist */
export const trackTableRows = (scope = "") =>
	[...document.querySelectorAll(`${scope} [data-test="tracklist-row"]`)].filter(
		(row) => row.closest(`[data-test="media-table-suggested-items"]`) === null,
	);
