/**
 * Coverage floors. Shared by `vitest.config.ts` (which enforces them) and `coverageComment.ts` (which reports them on
 * the PR), so the number CI enforces and the number the comment says are always the same one.
 *
 * Kept current by `pnpm run coverage:thresholds`, which CI runs on every push to master/dev and commits when it raises
 * one. They only ever go up: raise them by adding tests, never by lowering the number to make a build pass.
 */
export const coverageThresholds = {
	lines: 80,
	statements: 78,
	branches: 69,
	functions: 77,
} as const;

export type CoverageMetric = keyof typeof coverageThresholds;
export const coverageMetrics: CoverageMetric[] = ["lines", "statements", "branches", "functions"];
