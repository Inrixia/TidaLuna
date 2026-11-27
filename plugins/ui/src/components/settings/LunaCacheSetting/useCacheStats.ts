import React from "react";

import { Tracer, type CacheControl, type CacheStats } from "@luna/core";

export const { trace } = Tracer("[@luna/ui]", null);

/** The stats of `cache` while mounted: read once, then as its `onStats` pushes them */
export const useCacheStats = (cache: CacheControl) => {
	const [stats, setStats] = React.useState<CacheStats>();
	React.useEffect(() => {
		let pushed = false;
		let stopped = false;
		const stop = cache.onStats(new Set(), (stats) => {
			pushed = true;
			setStats(stats);
		});
		Promise.resolve(cache.stats())
			// A push that came first is newer
			.then((stats) => !stopped && !pushed && setStats(stats))
			.catch(trace.err.withContext("stats", cache.key));
		return () => {
			stopped = true;
			stop();
		};
	}, [cache]);
	return stats;
};
