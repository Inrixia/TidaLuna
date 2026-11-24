import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { unloadSet, type LunaUnload } from "./unloadSet";

const { reported } = vi.hoisted(() => ({ reported: [] as any[][] }));

/**
 * `unloadSet` reports failures through `coreTrace.msg.err`, which dispatches to TIDAL's redux store and so boots
 * `render/src/modules.ts` (it resolves TIDAL's react/oby chunks). Capture the trace calls instead; `createLogger`
 * itself is covered by ../trace/createLogger.test.ts.
 */
vi.mock("../trace", () => ({
	coreTrace: {
		msg: {
			err: {
				withContext:
					(...context: any[]) =>
					(...data: any[]) => {
						reported.push([...context, ...data]);
					},
			},
		},
	},
}));

/** Unload functions carry the source of what they registered, see `unloadableEmitter` in @inrixia/helpers */
const withSource = (unload: () => unknown, source: string): LunaUnload => Object.assign(unload, { source }) as LunaUnload;

describe("unloadSet", () => {
	beforeEach(() => {
		// Every unload races a 5s timeout; fake timers keep the test fast and drop the leftover timers
		vi.useFakeTimers();
		reported.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("runs every unload and clears the set", async () => {
		const ran: string[] = [];
		const unloads = new Set<LunaUnload>([() => ran.push("first"), () => ran.push("second"), () => ran.push("third")]);

		await unloadSet(unloads);

		expect(ran).toEqual(["first", "second", "third"]);
		expect(unloads.size).toBe(0);
		expect(reported).toEqual([]);

		// Cleared, so calling it again doesn't run anything twice
		await unloadSet(unloads);
		expect(ran).toEqual(["first", "second", "third"]);
	});

	test("takes a snapshot of the set, so an unload that removes itself still runs exactly once", async () => {
		const ran: string[] = [];
		const unloads = new Set<LunaUnload>();
		const selfRemoving = () => {
			ran.push("self");
			unloads.delete(selfRemoving);
		};
		unloads.add(selfRemoving);
		unloads.add(() => ran.push("other"));

		await unloadSet(unloads);

		expect(ran).toEqual(["self", "other"]);
		expect(unloads.size).toBe(0);
	});

	test("a throwing unload is reported through the trace and doesn't stop the others", async () => {
		const boom = new Error("boom");
		const ran: string[] = [];
		const removeListener = () => {
			throw boom;
		};
		const unloads = new Set<LunaUnload>([() => ran.push("before"), withSource(removeListener, "plugin.unloads"), () => ran.push("after")]);

		await unloadSet(unloads);

		expect(ran).toEqual(["before", "after"]);
		// Cleared even though one of them failed
		expect(unloads.size).toBe(0);
		expect(reported).toHaveLength(1);
		expect(reported[0][0]).toBe("Error unloading plugin.unloads.removeListener");
		expect(reported[0][1]).toBe(boom);
	});

	test("an async unload that rejects is reported and the rest still run", async () => {
		const boom = new Error("async boom");
		const ran: string[] = [];
		const unloads = new Set<LunaUnload>([
			async () => {
				ran.push("async");
				throw boom;
			},
			() => ran.push("sync"),
		]);

		await unloadSet(unloads);

		expect(ran).toEqual(["async", "sync"]);
		expect(unloads.size).toBe(0);
		expect(reported).toHaveLength(1);
		expect(reported[0][1]).toBe(boom);
	});

	test("null, undefined and empty sets are no-ops", async () => {
		await expect(unloadSet()).resolves.toBeUndefined();
		await expect(unloadSet(null)).resolves.toBeUndefined();
		await expect(unloadSet(new Set())).resolves.toBeUndefined();
		expect(reported).toEqual([]);
	});

	test("an unload that never finishes is given 5s, then reported, without blocking the rest", async () => {
		const ran: string[] = [];
		const unloads = new Set<LunaUnload>([() => ran.push("quick"), () => new Promise<void>(() => {})]);
		const done = unloadSet(unloads);

		// Still within the 5s budget: nothing reported and nothing cleared yet
		await vi.advanceTimersByTimeAsync(4999);
		expect(reported).toEqual([]);
		expect(unloads.size).toBe(2);

		await vi.advanceTimersByTimeAsync(1);
		await done;

		expect(ran).toEqual(["quick"]);
		expect(unloads.size).toBe(0);
		expect(reported).toHaveLength(1);
		expect(reported[0][1]).toBeInstanceOf(Error);
		expect(reported[0][1].message).toBe("Unload took longer than 5s to run...");
	});

	test("awaits async unloads before clearing the set", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const order: string[] = [];
		const unloads = new Set<LunaUnload>([
			async () => {
				await gate;
				order.push("async");
			},
			() => order.push("sync"),
		]);

		const done = unloadSet(unloads);
		await vi.advanceTimersByTimeAsync(0);

		expect(order).toEqual(["sync"]);
		// Not cleared while an unload is still running
		expect(unloads.size).toBe(2);

		release();
		await done;

		expect(order).toEqual(["sync", "async"]);
		expect(unloads.size).toBe(0);
		expect(reported).toEqual([]);
	});
});
