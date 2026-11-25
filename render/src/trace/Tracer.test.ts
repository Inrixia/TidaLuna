import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * The real Tracer, not the stand-in in test/harness/core.ts: `.msg.*` goes through Messager, which imports TIDAL's
 * store from `../modules` when it dispatches. That module boots TIDAL, so its store is replaced here.
 */
const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../modules", () => ({ reduxStore: { dispatch } }));

import { buildActions } from "../exposeTidalInternals.patchAction";
import { Tracer } from "./Tracer";

afterEach(() => {
	vi.restoreAllMocks();
	dispatch.mockReset();
});

describe("Tracer", () => {
	test("err sets errSignal to the error text, objects left out", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { trace, errSignal } = Tracer("[plugin]");
		expect(errSignal?._).toBeUndefined();

		trace.err("failed", new Error("boom"), { a: 1 }, 2);

		expect(errSignal?._).toBe("failed boom  2");
		// Every argument is forwarded to the console, objects included
		const error = new Error("boom");
		trace.err("again", error, { a: 1 }, 2);
		expect(consoleError).toHaveBeenLastCalledWith("[plugin]", "again", error, { a: 1 }, 2);
	});

	test("withSource extends the source and keeps the same errSignal", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { trace, errSignal } = Tracer("[plugin]");

		const sub = trace.withSource(".sub");
		sub.trace.err("again");

		expect(sub.errSignal).toBe(errSignal);
		expect(errSignal?._).toBe("again");
		expect(consoleError).toHaveBeenCalledWith("[plugin].sub", "again");
	});

	test("with a null errSignal, err only logs", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { trace, errSignal } = Tracer("[core]", null);

		trace.err("x");

		expect(errSignal).toBeNull();
		expect(consoleError).toHaveBeenCalledWith("[core]", "x");
	});

	test("log, warn and debug go to their own console method", () => {
		// Tracer takes the console methods when it is made, so spy first
		const spies = (["log", "warn", "debug"] as const).map((level) => [level, vi.spyOn(console, level).mockImplementation(() => {})] as const);
		const { trace } = Tracer("[p]");

		for (const [level, spy] of spies) {
			trace[level]("hi");
			expect(spy).toHaveBeenCalledExactlyOnceWith("[p]", "hi");
		}
	});

	test("msg logs and also shows the message in TIDAL", async () => {
		for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
		const { trace, errSignal } = Tracer("[p]");

		trace.msg.log("info", 1);
		trace.msg.warn("warn");
		trace.msg.err(new Error("bad"));

		// Messager imports the store before it dispatches
		await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(3));
		// test/setup-dom.ts seeds the message builders as (payload) => ({ type, payload })
		expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
			{ type: "message/MESSAGE_INFO", payload: { message: "[p] info 1", category: "OTHER", severity: "INFO" } },
			{ type: "message/MESSAGE_WARN", payload: { message: "[p] warn", category: "OTHER", severity: "WARN" } },
			{ type: "message/MESSAGE_ERROR", payload: { message: "[p] bad", category: "OTHER", severity: "ERROR" } },
		]);
		expect(console.log).toHaveBeenCalledWith("[p]", "info", 1);
		expect(console.warn).toHaveBeenCalledWith("[p]", "warn");
		expect(console.error).toHaveBeenCalledWith("[p]", expect.objectContaining({ message: "bad" }));
		// msg.err also sets the signal
		expect(errSignal?._).toBe("bad");
	});

	test("msg before TIDAL has built its message actions only logs", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const builder = buildActions["message/MESSAGE_INFO"];
		delete buildActions["message/MESSAGE_INFO"];
		try {
			Tracer("[p]").trace.msg.log("early");
			// Messager imports the store before it dispatches: give a (wrongly) pending dispatch time to happen
			await new Promise((resolve) => setTimeout(resolve, 20));
			// A real redux store rejects dispatch(undefined)
			expect(dispatch).not.toHaveBeenCalled();
			expect(console.log).toHaveBeenCalledWith("[p]", "early");
		} finally {
			buildActions["message/MESSAGE_INFO"] = builder;
		}
	});
});
