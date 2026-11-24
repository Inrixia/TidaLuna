import path from "path";
import sanitize from "sanitize-filename";

/**
 * The file in `dir` that `relativePath` (a `meta.path`, `/` between folders) names. Every segment is sanitized, one that is empty after that
 * (or `..`), an absolute path, or a result outside `dir` throws: a path built from a key must never reach beyond the cache's folder
 */
export const resolveInside = (dir: string, relativePath: unknown): string => {
	if (typeof relativePath !== "string" || relativePath === "") throw new Error("Cache meta has no path");
	if (path.isAbsolute(relativePath) || /^[\\/]/.test(relativePath)) throw new Error(`Cache path ${relativePath} is absolute`);
	const segments = relativePath.split(/[\\/]/).map((segment) => {
		if (segment === "..") throw new Error(`Cache path ${relativePath} has ..`);
		const clean = sanitize(segment);
		if (clean === "") throw new Error(`Cache path ${relativePath} has an empty segment`);
		return clean;
	});
	const root = path.resolve(dir);
	const resolved = path.join(root, ...segments);
	if (!resolved.startsWith(root + path.sep)) throw new Error(`Cache path ${relativePath} is outside its folder`);
	return resolved;
};
