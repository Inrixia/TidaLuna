import { describe, expect, test, vi } from "vitest";

import { hookUpdater, repairAfterUpdate, type RepairDeps, type UpdaterLike } from "./updaterHook";
import type { TidalInstall } from "./tidalInstall";

/**
 * The updater hook is what makes Luna survive an update in the same session, so each way it can leave a user with a
 * TIDAL that has no Luna in it (or no TIDAL at all) is a case here. Everything is injectable, so these run without
 * Electron, Squirrel or a real install.
 */
const install = (version: string): TidalInstall => ({ appDir: `C:\\T\\app-${version}`, resourcesDir: `C:\\T\\app-${version}\\resources`, version });

const updater = () => {
	const calls: unknown[][] = [];
	const fake: UpdaterLike = { quitAndInstall: (...args: unknown[]) => void calls.push(args) };
	return { fake, calls };
};

describe("hookUpdater", () => {
	test("holds the relaunch back and keeps the apply", () => {
		const { fake, calls } = updater();
		const spawnRepair = vi.fn();
		hookUpdater({ updater: fake, spawnRepair, log: () => {} });

		fake.quitAndInstall(false, true);

		expect(spawnRepair).toHaveBeenCalledTimes(1);
		// silent preserved, relaunch forced off: the repair owns it once Luna is back in the new version
		expect(calls).toEqual([[false, false]]);
	});

	test("keeps the caller's silent flag", () => {
		const { fake, calls } = updater();
		hookUpdater({ updater: fake, spawnRepair: () => {}, log: () => {} });

		fake.quitAndInstall(true, true);

		expect(calls).toEqual([[true, false]]);
	});

	test("a repair that cannot start does not also stop the relaunch", () => {
		// Risk: forcing forceRunAfter off and then failing to repair leaves the user with no TIDAL at all
		const { fake, calls } = updater();
		const logs: string[] = [];
		hookUpdater({
			updater: fake,
			spawnRepair: () => {
				throw new Error("no spawn");
			},
			log: (m) => logs.push(m),
		});

		fake.quitAndInstall(false, true);

		// The caller's own arguments are passed through, so Squirrel relaunches as it would have
		expect(calls).toEqual([[false, true]]);
		expect(logs.join("\n")).toContain("no spawn");
	});

	test("hooking twice does not stack wrappers", () => {
		// Risk: a reload (or the guard running twice) would otherwise spawn two repairs and quit twice
		const { fake, calls } = updater();
		const first = vi.fn();
		const second = vi.fn();
		hookUpdater({ updater: fake, spawnRepair: first, log: () => {} });
		hookUpdater({ updater: fake, spawnRepair: second, log: () => {} });

		fake.quitAndInstall();

		expect(first).toHaveBeenCalledTimes(1);
		expect(second).not.toHaveBeenCalled();
		expect(calls).toHaveLength(1);
	});

	test("unhooking restores the real quitAndInstall", () => {
		const { fake, calls } = updater();
		const original = fake.quitAndInstall;
		const unhook = hookUpdater({ updater: fake, spawnRepair: () => {}, log: () => {} });

		unhook();
		fake.quitAndInstall(true, true);

		// Back to the updater's own behaviour, relaunch included
		expect(calls).toEqual([[true, true]]);
		expect(fake.quitAndInstall).not.toBe(original); // restored as a bound copy, still the same behaviour
	});

	test("no updater, or no quitAndInstall, is a supported answer", () => {
		// Risk: Linux has no autoUpdater, and the hook must not throw on the boot path there
		const logs: string[] = [];
		expect(() => hookUpdater({ updater: undefined, spawnRepair: () => {}, log: (m) => logs.push(m) })()).not.toThrow();
		const broken = { quitAndInstall: undefined } as unknown as UpdaterLike;
		expect(() => hookUpdater({ updater: broken, spawnRepair: () => {}, log: (m) => logs.push(m) })()).not.toThrow();
		expect(logs.join("\n")).toContain("no autoUpdater");
	});
});

describe("repairAfterUpdate", () => {
	const deps = (over: Partial<RepairDeps> & { installs?: TidalInstall[] } = {}) => {
		let clock = 0;
		const launched = vi.fn();
		const injected: TidalInstall[] = [];
		const logs: string[] = [];
		const base: RepairDeps = {
			listInstalls: async () => over.installs ?? [install("2.49.0")],
			written: async () => true,
			inject: async (i) => {
				injected.push(i);
				return { lunaVersion: "1.25.0", tidalVersion: i.version, asarBytes: 1, asarMtimeMs: 1, injectedAt: "" };
			},
			compatible: async () => true,
			launch: launched,
			sleep: async (ms) => void (clock += ms),
			now: () => clock,
			log: (m) => logs.push(m),
			timeoutMs: 1000,
			pollMs: 100,
			...over,
		};
		return { deps: base, launched, injected, logs };
	};

	test("installs this Luna into the new version, then starts TIDAL", async () => {
		const { deps: d, launched, injected } = deps();

		const result = await repairAfterUpdate(d, "2.48.0");

		expect(result).toMatchObject({ action: "injected", version: "2.49.0", launched: true });
		expect(injected.map((i) => i.version)).toEqual(["2.49.0"]);
		expect(launched).toHaveBeenCalledTimes(1);
	});

	test("waits for the new version to be fully written before touching it", async () => {
		// Risk: injecting while Squirrel is still writing corrupts the new version
		let checks = 0;
		const { deps: d, injected } = deps({ written: async () => ++checks > 3 });

		const result = await repairAfterUpdate(d, "2.48.0");

		expect(result.action).toBe("injected");
		expect(checks).toBe(4);
		expect(injected).toHaveLength(1);
	});

	test("starts TIDAL anyway when the update never appears", async () => {
		// Risk: the user is left with no client at all
		const { deps: d, launched, injected } = deps({ installs: [install("2.48.0")] });

		const result = await repairAfterUpdate(d, "2.48.0");

		expect(result).toMatchObject({ action: "timed-out", launched: true });
		expect(injected).toHaveLength(0);
		expect(launched).toHaveBeenCalledTimes(1);
	});

	test("starts TIDAL without Luna when this Luna is not known to support the new one", async () => {
		// Risk: relaunching a new TIDAL into a Luna that does not match it, which is worse than an unmodded client
		const { deps: d, launched, injected, logs } = deps({ compatible: async () => undefined });

		const result = await repairAfterUpdate(d, "2.48.0");

		expect(result.action).toBe("skipped-incompatible");
		expect(injected).toHaveLength(0);
		expect(launched).toHaveBeenCalledTimes(1);
		expect(logs.join("\n")).toContain("support is unknown");
	});

	test("refuses to install a version it knows is unsupported", async () => {
		const { deps: d, injected } = deps({ compatible: async () => false });

		expect((await repairAfterUpdate(d, "2.48.0")).action).toBe("skipped-incompatible");
		expect(injected).toHaveLength(0);
	});

	test("a failed install still leaves the user a TIDAL to open", async () => {
		const { deps: d, launched } = deps({
			inject: async () => {
				throw new Error("resources is a link");
			},
		});

		const result = await repairAfterUpdate(d, "2.48.0");

		expect(result).toMatchObject({ action: "failed", launched: true });
		expect((result as { reason: string }).reason).toContain("resources is a link");
		expect(launched).toHaveBeenCalledTimes(1);
	});

	test("an install list that keeps failing still ends with TIDAL started", async () => {
		const { deps: d, launched, logs } = deps({
			listInstalls: async () => {
				throw new Error("no access");
			},
		});

		expect((await repairAfterUpdate(d, "2.48.0")).action).toBe("timed-out");
		expect(launched).toHaveBeenCalledTimes(1);
		expect(logs.join("\n")).toContain("could not list TIDAL installs");
	});

	test("an install with no version in its path is treated as the updated one", async () => {
		// Risk: flatpak and /opt installs carry no version, and they are the Linux case
		const { deps: d, injected } = deps({ installs: [{ appDir: "/opt/tidal-hifi", resourcesDir: "/opt/tidal-hifi/resources" }] });

		expect((await repairAfterUpdate(d, "2.48.0")).action).toBe("injected");
		expect(injected).toHaveLength(1);
	});
});

describe("falling back to a release that fits", () => {
	const deps = (over: Partial<RepairDeps> = {}) => {
		let clock = 0;
		const launched = vi.fn();
		const logs: string[] = [];
		const base: RepairDeps = {
			listInstalls: async () => [install("2.49.0")],
			written: async () => true,
			inject: async () => ({ lunaVersion: "1.25.0", asarBytes: 1, asarMtimeMs: 1, injectedAt: "" }),
			compatible: async () => undefined,
			launch: launched,
			sleep: async (ms) => void (clock += ms),
			now: () => clock,
			log: (m) => logs.push(m),
			timeoutMs: 1000,
			pollMs: 100,
			...over,
		};
		return { deps: base, launched, logs };
	};

	test("installs a matching release when this build does not fit", async () => {
		// Risk: relaunching a new TIDAL into a Luna written for the old one. This is the logon run's answer, reached now
		const escalate = vi.fn(async () => true);
		const { deps: d, launched } = deps({ escalate });

		const result = await repairAfterUpdate(d, "2.48.0");

		expect(result).toMatchObject({ action: "installed-release", launched: true });
		expect(escalate).toHaveBeenCalledTimes(1);
		expect(launched).toHaveBeenCalledTimes(1);
	});

	test("a fallback that finds nothing still starts TIDAL", async () => {
		const { deps: d, launched } = deps({ escalate: async () => false });

		expect((await repairAfterUpdate(d, "2.48.0")).action).toBe("skipped-incompatible");
		expect(launched).toHaveBeenCalledTimes(1);
	});

	test("a fallback that throws still starts TIDAL", async () => {
		const { deps: d, launched, logs } = deps({
			escalate: async () => {
				throw new Error("no network");
			},
		});

		expect((await repairAfterUpdate(d, "2.48.0")).action).toBe("skipped-incompatible");
		expect(launched).toHaveBeenCalledTimes(1);
		expect(logs.join("\n")).toContain("no network");
	});
});
