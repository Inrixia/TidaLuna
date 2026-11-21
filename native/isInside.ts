import path from "path";

/** True if `target` is `dir` or inside it. A plain `target.startsWith(dir)` also matches siblings such as `app-old`. */
export const isInside = (dir: string, target: string) => {
	const rel = path.relative(dir, target);
	return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};
