import { tidalModules } from "@luna/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { findModuleByProperty, findModuleProperty, recursiveSearch } from "./findModule";

/**
 * `findModuleByProperty` reports misses through `coreTrace.warn`, which `createLogger` bound to `console.warn` when
 * Tracer.ts was first imported. Spying from `vi.hoisted` wins that race, so the warning is observable.
 */
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.spyOn(console, "warn").mockImplementation(() => {}) }));

/**
 * `recursiveSearch` walks TIDAL's module map, which the harness exposes empty. Seed it per test and empty it again,
 * and give every test its own selector: findModuleProperty/findModuleByProperty memoize per selector identity.
 */
const seed = (modules: Record<string, object>) => Object.assign(tidalModules, modules);

const resetModules = () => {
	for (const key of Object.keys(tidalModules)) delete tidalModules[key];
	warnSpy.mockClear();
};

describe("recursiveSearch", () => {
	beforeEach(resetModules);

	test("finds nested properties and yields the path it took", () => {
		const root = { a: { b: { c: 42 } } };

		const found = [...recursiveSearch(root, (key) => key === "c")];

		expect(found).toEqual([{ value: 42, path: ["a", "b", "c"] }]);
	});

	test("yields matches depth first", () => {
		const root = { outer: { leaf: 1 }, sibling: 2 };

		const matches = [...recursiveSearch(root, (_key, value) => typeof value === "number")];

		// The leaf inside `outer` is yielded before `sibling`, which is a later key of the root
		expect(matches.map((match) => match.path)).toEqual([["outer", "leaf"], ["sibling"]]);
		expect(matches.map((match) => match.value)).toEqual([1, 2]);
	});

	test("indexes arrays by their stringified indices", () => {
		const root = { list: [1, 2, 3], ofObjects: [{ id: 7 }] };

		const scalar = [...recursiveSearch(root, (_key, value) => value === 2)];
		const nested = [...recursiveSearch(root, (key) => key === "id")];

		expect(scalar).toHaveLength(1);
		// The array's index is the key, as a string
		expect(scalar[0].path).toEqual(["list", "1"]);
		expect(scalar[0].value).toBe(2);
		expect(nested[0].path).toEqual(["ofObjects", "0", "id"]);
	});

	test("yields functions but doesn't walk into them", () => {
		const fn = Object.assign(() => "hi", { marker: 42 });

		const found = [...recursiveSearch({ util: { fn } }, (key) => key === "fn")];
		const insideFunction = [...recursiveSearch({ fn }, (key) => key === "marker")];

		expect(found).toHaveLength(1);
		expect(found[0].value).toBe(fn);
		expect(found[0].path).toEqual(["util", "fn"]);
		expect(insideFunction).toEqual([]);
	});

	test("visits every object once, so a cycle terminates", () => {
		const root: any = { name: "root" };
		root.self = root;
		root.child = { parent: root, name: "child" };

		const found = [...recursiveSearch(root, (key) => key === "name")];

		// `child.parent` is the root, which `seen` already holds
		expect(found.map((match) => match.path)).toEqual([["name"], ["child", "name"]]);
	});

	test("stops at window instead of walking the whole page", () => {
		expect([...recursiveSearch(window as any, () => true)]).toEqual([]);

		const found = [...recursiveSearch({ win: window }, (key) => key === "win")];

		expect(found).toHaveLength(1);
		expect(found[0].value).toBe(window);
		expect(found[0].path).toEqual(["win"]);
	});

	test("falls back to the prototype's keys when an object has no own keys", () => {
		class Player {
			public get duration() {
				return 7;
			}
		}

		const found = [...recursiveSearch({ player: new Player() }, (key) => key === "duration")];

		expect(found).toEqual([{ value: 7, path: ["player", "duration"] }]);
	});

	test("skips a property that throws when read", () => {
		const root = {
			get boom(): number {
				throw new Error("boom");
			},
			safe: 1,
		};

		const found = [...recursiveSearch(root, (key) => key === "safe" || key === "boom")];

		expect(found).toEqual([{ value: 1, path: ["safe"] }]);
	});
});

describe("findModuleProperty", () => {
	beforeEach(resetModules);

	test("returns the first property the selector matches, with its path into tidalModules", () => {
		const play = () => "playing";
		seed({ "test.player": { transport: { play } } });

		const found = findModuleProperty((key) => key === "play");

		expect(found?.value).toBe(play);
		expect(found?.path).toEqual(["test.player", "transport", "play"]);
	});

	test("returns undefined when nothing matches", () => {
		seed({ "test.player": { play: () => "playing" } });

		expect(findModuleProperty((key) => key === "definitely not there")).toBeUndefined();
	});

	test("memoizes by selector, so later calls see the first result", () => {
		seed({ "test.player": { play: "first" } });
		const selector = (key: unknown) => key === "play";

		const first = findModuleProperty(selector);
		seed({ "test.player": { play: "second" } });
		const second = findModuleProperty(selector);

		expect(second).toBe(first);
		expect(second?.value).toBe("first");
		// A different selector is a different lookup
		expect(findModuleProperty((key) => key === "play")?.value).toBe("second");
	});
});

describe("findModuleByProperty", () => {
	beforeEach(resetModules);

	test("returns the module object that holds the matched property", () => {
		const transport = { play: () => "playing" };
		seed({ "test.player": { transport }, "test.other": { unrelated: true } });

		expect(findModuleByProperty((key) => key === "play")).toBe(transport);
	});

	test("returns the parent of a deeply nested match", () => {
		const nested = { deep: 1 };
		seed({ "test.a": { nested } });

		expect(findModuleByProperty((key) => key === "deep")).toBe(nested);
	});

	test("warns and returns undefined when the selector matches nothing", () => {
		seed({ "test.player": { play: () => "playing" } });
		const selector = (key: unknown) => key === "definitely not there";

		expect(findModuleByProperty(selector)).toBeUndefined();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]).toEqual(["[@luna/core]", "findModuleByProperty", "Unable to find module using selector:", selector]);
	});

	test("memoizes by selector", () => {
		const first = { found: true };
		seed({ "test.a": first });
		const selector = (key: unknown) => key === "found";

		const found = findModuleByProperty(selector);
		seed({ "test.a": { found: false } });

		expect(found).toBe(first);
		expect(findModuleByProperty(selector)).toBe(first);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
