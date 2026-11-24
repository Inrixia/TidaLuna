import { describe, expect, test, vi } from "vitest";

import { createLogger, type LogConsumer } from "./createLogger";

/** Capture what is thrown without letting it escape the test */
const capture = (fn: () => void): unknown => {
	try {
		fn();
	} catch (err) {
		return err;
	}
	throw new Error("expected the call to throw");
};

describe("createLogger", () => {
	test("prefixes every log with its source", () => {
		const consumer = vi.fn();
		const log = createLogger("[plugin]", consumer);
		const err = new Error("boom");

		log("hello", 1);
		log(err);

		expect(consumer).toHaveBeenNthCalledWith(1, "[plugin]", "hello", 1);
		expect(consumer).toHaveBeenNthCalledWith(2, "[plugin]", err);
	});

	test("returns whatever the consumer returns", () => {
		// Consumers are typed void, the logger still hands their return value back to the caller
		const log = createLogger("[plugin]", (() => "sent") as unknown as LogConsumer);
		expect(log("x")).toBe("sent");
	});

	test("withContext puts the context in front of the data and has a .throw of its own", () => {
		const consumer = vi.fn();
		const log = createLogger("[plugin]", consumer);

		const logCtx = log.withContext("loadPlugin", "failed");
		logCtx("reason", 2);

		expect(consumer).toHaveBeenCalledWith("[plugin]", "loadPlugin", "failed", "reason", 2);
		expect(typeof logCtx.throw).toBe("function");
	});

	test("throw rethrows an Error instance as-is, leaving it untouched", () => {
		const consumer = vi.fn();
		const log = createLogger("[plugin]", consumer);
		const err = new Error("boom");

		expect(() => log.throw(err)).toThrow("boom");
		expect(capture(() => log.throw(err))).toBe(err);
		// Logged like any other call, and the Error is not modified
		expect(consumer).toHaveBeenCalledWith("[plugin]", err);
		expect(err.cause).toBeUndefined();
	});

	test("withContext.throw rethrows an Error instance as-is and sets the context as its cause", () => {
		const log = createLogger("[plugin]", vi.fn());
		const err = new Error("boom");

		expect(capture(() => log.withContext("loadPlugin").throw(err))).toBe(err);
		expect(err.message).toBe("boom");
		expect(err.cause).toBe("[plugin] loadPlugin");
	});

	test("throw wraps a non-Error in an Error whose cause is the source", () => {
		const consumer = vi.fn();
		const log = createLogger("[plugin]", consumer);

		const thrown = capture(() => log.throw("something", "bad", 1));

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("[plugin] something bad 1");
		expect((thrown as Error).cause).toBe("[plugin]");
		// Logged before throwing
		expect(consumer).toHaveBeenCalledWith("[plugin]", "something", "bad", 1);
	});

	test("withContext.throw wraps a non-Error with the context in the message and the source as cause", () => {
		const log = createLogger("[plugin]", vi.fn());

		const thrown = capture(() => log.withContext("loadPlugin", "failed").throw("reason", 2));

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("[plugin] loadPlugin failed reason 2");
		expect((thrown as Error).cause).toBe("[plugin]");
	});

	test("throw with no arguments still throws an Error naming the source", () => {
		const log = createLogger("[plugin]", vi.fn());

		const thrown = capture(() => log.throw());

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("[plugin]");
		expect((thrown as Error).cause).toBe("[plugin]");
	});
});
