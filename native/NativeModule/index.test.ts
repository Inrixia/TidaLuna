import { ipcMain } from "electron";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The handler registerNative installs for a native module's channel is where the core rules are enforced: a deny rule
 * throws, a confirm rule asks first, arguments are checked before the window opens. policy.test.ts covers the rules
 * as data; these tests drive the handler itself.
 */
const mocks = vi.hoisted(() => {
	// index.ts builds a require from process.resourcesPath when it is imported
	(process as unknown as { resourcesPath: string }).resourcesPath = process.cwd();
	return {
		ask: vi.fn<(request: { title: string; lines: string[]; confirmText: string }) => Promise<boolean>>(),
		askerFor: vi.fn(),
		secureLoad: vi.fn(),
		isCoreNative: vi.fn(async (_hash: string) => true),
	};
});
vi.mock("../core/confirmWindow", () => ({ askerFor: mocks.askerFor }));
vi.mock("./secureLoad", () => ({ secureLoad: mocks.secureLoad }));
vi.mock("./coreNatives", () => ({ isCoreNative: mocks.isCoreNative }));
vi.mock("../expose", () => ({}));
vi.mock("../core/legacyListMain", () => ({ legacyListReady: async () => {} }));
// A plugin's native file is owned by an enabled plugin whose accepted code holds it (core/registry.ts)
vi.mock("../core/registryMain", () => ({
	registry: () => ({ nativeOwner: () => "https://plugin.example/p", legacyRefusal: () => undefined, ownsNative: () => true }),
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
/** Taken when index.ts is imported and again at every registration: a mock reset between tests would drop the calls */
const registered = new Map<string, Handler>();
const handlers = () => {
	for (const [channel, handler] of vi.mocked(ipcMain.handle).mock.calls) registered.set(channel, handler as unknown as Handler);
	return registered;
};

const exportsOf = () => ({
	sendToRender: vi.fn(async () => "sent"),
	update: vi.fn(async (version: string) => `updated ${version}`),
	pkg: vi.fn(async () => ({ version: "1.0.0" })),
	allowed: vi.fn(async (a: number) => a + 1),
	throwsPrimitive: vi.fn(async () => {
		throw "boom";
	}),
});

let exports_: ReturnType<typeof exportsOf>;
const event = { sender: { id: 1 } };

/** Registers a module and returns the handler of its channel */
const register = async (fileName: string, { isCore = true }: { isCore?: boolean } = {}) => {
	mocks.isCoreNative.mockResolvedValue(isCore);
	exports_ = exportsOf();
	mocks.secureLoad.mockResolvedValue(exports_);
	const channel = (await handlers().get("__Luna.registerNative")!(event, fileName, `code of ${fileName}`)) as string;
	expect(channel).toBe(`__LunaNative.${fileName}`);
	return handlers().get(channel)!;
};

beforeAll(async () => {
	await import("./index");
	handlers();
});

beforeEach(() => {
	mocks.ask.mockReset().mockResolvedValue(true);
	mocks.askerFor.mockReset().mockReturnValue(mocks.ask);
});

describe("a core native's channel", () => {
	it("refuses sendToRender from the page without running it", async () => {
		const call = await register("core-deny.native.ts");

		await expect(call(event, "sendToRender", "channel", "payload")).rejects.toThrow("sendToRender can't be called from the page");

		expect(exports_.sendToRender).not.toHaveBeenCalled();
		expect(mocks.ask).not.toHaveBeenCalled();
	});

	it("refuses an export name that is not a string before looking it up", async () => {
		const call = await register("core-name.native.ts");
		// toString would make this look like "sendToRender" to a lookup that coerces it
		const sneaky = { toString: () => "sendToRender" };

		await expect(call(event, sneaky)).rejects.toThrow("Export names must be strings");
		await expect(call(event, ["sendToRender"])).rejects.toThrow("Export names must be strings");

		expect(exports_.sendToRender).not.toHaveBeenCalled();
	});

	it("rejects arguments that can't run before it asks the user", async () => {
		const call = await register("core-args.native.ts");

		await expect(call(event, "update", "../../evil")).rejects.toThrow('update: invalid version "../../evil"');
		await expect(call(event, "update")).rejects.toThrow("update: invalid version");

		expect(mocks.ask).not.toHaveBeenCalled();
		expect(exports_.update).not.toHaveBeenCalled();
	});

	it("doesn't ask for a confirmed export the module doesn't have", async () => {
		const call = await register("core-missing.native.ts");
		delete (exports_ as Partial<typeof exports_>).update;

		await expect(call(event, "update", "1.2.3")).rejects.toThrow("has no export update");

		expect(mocks.ask).not.toHaveBeenCalled();
	});

	it("throws when the user cancels, and doesn't run the export", async () => {
		const call = await register("core-cancel.native.ts");
		mocks.ask.mockResolvedValue(false);

		await expect(call(event, "update", "1.2.3")).rejects.toThrow("update cancelled by the user");

		expect(mocks.ask).toHaveBeenCalledTimes(1);
		expect(exports_.update).not.toHaveBeenCalled();
	});

	it("asks with the installed version and runs the export when the user confirms", async () => {
		const call = await register("core-confirm.native.ts");

		await expect(call(event, "update", "1.2.3")).resolves.toBe("updated 1.2.3");

		expect(mocks.askerFor).toHaveBeenCalledWith(event.sender);
		const [request] = mocks.ask.mock.calls[0];
		expect(request.title).toBe("Update Luna?");
		expect(request.lines.join("\n")).toContain("Installed now: 1.0.0 -> 1.2.3");
		expect(exports_.update).toHaveBeenCalledExactlyOnceWith("1.2.3");
	});

	it("runs the other exports without asking", async () => {
		const call = await register("core-allow.native.ts");

		await expect(call(event, "allowed", 1)).resolves.toBe(2);

		expect(mocks.ask).not.toHaveBeenCalled();
	});

	it("tags what a native throws with where it came from, also a primitive", async () => {
		const call = await register("core-throw.native.ts");
		exports_.allowed.mockRejectedValue(Object.assign(new Error("bad"), {}));

		const err = (await call(event, "allowed", 1).catch((e: unknown) => e)) as { cause?: unknown };
		expect(err.cause).toBe("[Luna.native] (core-throw.native.ts).allowed");

		await expect(call(event, "throwsPrimitive")).rejects.toBe("boom");
	});
});

describe("a plugin's channel", () => {
	it("is not subject to the core rules", async () => {
		const call = await register("plugin.native.ts", { isCore: false });

		await expect(call(event, "sendToRender")).resolves.toBe("sent");
		await expect(call(event, "update", "../x")).resolves.toBe("updated ../x");

		expect(mocks.ask).not.toHaveBeenCalled();
	});
});
