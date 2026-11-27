/**
 * Coverage floors. Shared by `vitest.config.ts` (which enforces them) and `coverageReport.ts` (which reports them on
 * the PR), so the number CI enforces and the number the comment says are always the same one.
 *
 * Kept current by `pnpm run coverage:thresholds`, which CI runs on every push to master/dev and commits when it raises
 * one. They only ever go up: raise them by adding tests, never by lowering the number to make a build pass.
 */
export const coverageThresholds = {
	lines: 81,
	statements: 80,
	branches: 71,
	functions: 79,
} as const;

export type CoverageMetric = keyof typeof coverageThresholds;
export const coverageMetrics: CoverageMetric[] = ["lines", "statements", "branches", "functions"];
