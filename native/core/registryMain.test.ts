// Run: pnpm exec vitest run native/core/registryMain.test.ts

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
vi.mock("../ipc", () => ({
	ipcHandle: (channel: string, listener: Handler) => void handlers.set(channel, listener),
}));
vi.mock("./confirmWindow", () => ({ askerFor: () => async () => true }));
vi.mock("../NativeModule/trust", () => ({
	allVersionsAnswers: () => [],
	forgetAnswers: () => undefined,
	revokeAllVersions: () => undefined,
}));
vi.mock("../NativeModule/permissions/verifySource", () => ({ nativeSourcesOf: () => [] }));

// A default store: page code can only name plugin urls of stores the user allowed (registry.ts fromStore)
const URL = "https://release.radiant-lyrics.org/plugin";
let userData: string;
const stateFile = () => path.join(userData, "luna-core", "plugins.json");

/** A fresh registryMain (so a fresh registry), with the fake Electron it just imported pointed at this test's userData */
const load = async (files?: Record<string, string>) => {
	vi.resetModules();
	handlers.clear();
	// The fake from test/harness (the `electron` alias), whose types are not electron's
	const electron = (await import("electron")) as unknown as typeof import("../../test/harness/electron");
	electron.setUserDataDir(userData);
	if (files !== undefined)
		(electron.net.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: unknown) => {
			const body = files[String(url)];
			return body === undefined ? new Response("", { status: 404 }) : new Response(body);
		});
	return import("./registryMain");
};
const call = async (channel: string, ...args: unknown[]) => {
	const handler = handlers.get(channel);
	if (handler === undefined) throw new Error(`no handler for ${channel}`);
	return handler({ sender: {} }, ...args);
};

beforeEach(() => {
	userData = mkdtempSync(path.join(os.tmpdir(), "luna-registry-main-"));
});
afterEach(() => {
	rmSync(userData, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("registryMain", () => {
	test("registers the __LunaCore channels", async () => {
		await load();
		expect([...handlers.keys()].sort()).toEqual(
			[
				"__LunaCore.acceptUpdate",
				"__LunaCore.allowStore",
				"__LunaCore.askHost",
				"__LunaCore.disable",
				"__LunaCore.enable",
				"__LunaCore.fetch",
				"__LunaCore.forgetGrant",
				"__LunaCore.info",
				"__LunaCore.install",
				"__LunaCore.list",
				"__LunaCore.load",
				"__LunaCore.migrate",
				"__LunaCore.moveUrl",
				"__LunaCore.networkLog",
				"__LunaCore.needsMigration",
				"__LunaCore.pageConnect",
				"__LunaCore.pageStores",
				"__LunaCore.storeOrigins",
				"__LunaCore.uninstall",
			].sort(),
		);
	});

	test("a missing state file starts fresh and offers migration", async () => {
		await load();
		expect(await call("__LunaCore.needsMigration")).toBe(true);
		expect(await call("__LunaCore.list")).toEqual([]);
	});

	test("migrated entries are written to userData/luna-core/plugins.json and read back by a new registry", async () => {
		await load();
		await call("__LunaCore.migrate", [{ url: URL, name: "plugin", enabled: false }]);
		await vi.waitFor(() => expect(existsSync(stateFile())).toBe(true));
		expect(existsSync(`${stateFile()}.tmp`)).toBe(false);
		expect(JSON.parse(readFileSync(stateFile(), "utf8")).plugins[URL].name).toBe("plugin");

		await load();
		expect(await call("__LunaCore.needsMigration")).toBe(false);
		expect(await call("__LunaCore.list")).toEqual([expect.objectContaining({ url: URL, name: "plugin", enabled: false })]);
	});

	test("a state file that does not parse is kept aside and a fresh registry starts", async () => {
		mkdirSync(path.dirname(stateFile()), { recursive: true });
		writeFileSync(stateFile(), "{not json");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await load();
		expect(await call("__LunaCore.needsMigration")).toBe(true);
		expect(existsSync(stateFile())).toBe(false);
		expect(readdirSync(path.dirname(stateFile())).some((name) => name.startsWith("plugins.json.unreadable-"))).toBe(true);
		expect(error).toHaveBeenCalled();
	});

	test("install fetches <url>.json and <url>.mjs, drops the code from the package and tags the code with its source", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		await load({
			[`${URL}.json`]: JSON.stringify({ name: "plugin", hash: "h1", version: "1.0.0", code: "must not be kept" }),
			[`${URL}.mjs`]: "export const x = 1;",
		});
		await call("__LunaCore.install", URL);

		expect(await call("__LunaCore.info", URL)).toEqual(expect.objectContaining({ url: URL, name: "plugin", installed: true, version: "1.0.0", hash: "h1" }));
		expect(await call("__LunaCore.load", URL)).toEqual(
			expect.objectContaining({ code: `export const x = 1;\n//# sourceURL=${URL}.mjs`, package: expect.not.objectContaining({ code: expect.anything() }) }),
		);
	});

	test("a package without a name is refused", async () => {
		await load({ [`${URL}.json`]: JSON.stringify({ hash: "h1" }), [`${URL}.mjs`]: "" });
		await expect(call("__LunaCore.install", URL)).rejects.toThrow(/has no name/);
	});

	test("a failed fetch names the url and status", async () => {
		await load({});
		await expect(call("__LunaCore.install", URL)).rejects.toThrow(/Failed to fetch .*plugin\.json: 404/);
	});

	test("a url that is not http(s) is refused", async () => {
		await load();
		await expect(call("__LunaCore.info", "file:///etc/passwd")).rejects.toThrow(/Not a plugin url/);
	});
});
