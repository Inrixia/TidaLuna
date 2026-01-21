import { memoize, type AnyRecord, type VoidLike } from "@inrixia/helpers";
import { tidalModules } from "../exposeTidalInternals";
import { coreTrace } from "../trace/Tracer";

export interface FoundProperty<T> {
	value: T;
	path: (string | symbol)[];
}

export const findModuleProperty = memoize(<T>(selector: (key: unknown, value: unknown) => boolean): FoundProperty<T> | VoidLike => {
	return recursiveSearch<T>(tidalModules, selector).next().value;
});

export const findModuleByProperty = memoize(<T extends object>(selector: (key: unknown, value: unknown) => boolean): T | VoidLike => {
	const foundProperty = recursiveSearch<T>(tidalModules, selector).next().value;
	if (foundProperty === undefined) return coreTrace.warn("findModuleByProperty", `Unable to find module using selector:`, selector);
	let module: object = tidalModules;
	// Remove the final path part
	foundProperty.path.pop();
	for (const key of foundProperty.path) module = module[key as keyof typeof module];
	return <T>module;
});

export function* recursiveSearch<T>(
	obj: AnyRecord,
	selector: (key: unknown, value: unknown) => boolean,
	seen = new Set<AnyRecord>(),
	path: (string | symbol)[] = [],
): Generator<FoundProperty<T>> {
	// Ignore window to avoid going out of bounds
	// Not ideal but this should only be called on module code anyway so blegh
	if (obj === window) return;
	if (seen.has(obj)) return;
	seen.add(obj);
	for (const key of getKeys(obj)) {
		try {
			const prop = obj[key];
			const currentPath = [...path, key];
			if (typeof prop === "object" && prop !== null) {
				for (const found of recursiveSearch<T>(prop, selector, seen, currentPath)) {
					if (found !== undefined) yield found;
				}
			}
			if (selector(key, prop)) yield { value: <T>prop, path: currentPath };
		} catch {}
	}
}

const getKeys = (obj: AnyRecord) => {
	const keys = Object.keys(obj);
	if (keys.length !== 0) return keys;
	return Reflect.ownKeys(Object.getPrototypeOf(obj) ?? obj);
};
