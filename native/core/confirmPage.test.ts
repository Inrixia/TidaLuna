import { describe, expect, it } from "vitest";

import {
	ANSWER_IN_USE_MS,
	buildConfirmHtml,
	confirmGate,
	confirmRequest,
	COOL_DOWN_MS,
	MAX_CANCELS,
	MAX_PENDING,
	type TidalState,
} from "./confirmPage";

const FOCUSED: TidalState = { visible: true, focused: true, recentUserInput: false };
const AWAY: TidalState = { visible: true, focused: false, recentUserInput: false };

describe("core confirmation gate", () => {
	it("refuses while TIDAL is not in use", () => {
		const gate = confirmGate();
		expect(gate.refuse({ tidal: AWAY, now: 0 })).toBe("TIDAL is not in use");
		expect(gate.pending).toBe(0);
	});

	it("takes recent input in TIDAL when focus isn't reported, but never a hidden TIDAL", () => {
		const gate = confirmGate();
		expect(gate.refuse({ tidal: { ...AWAY, recentUserInput: true }, now: 0 })).toBe(undefined);
		expect(gate.refuse({ tidal: { visible: false, focused: true, recentUserInput: true }, now: 0 })).toBe("TIDAL is not in use");
	});

	it("takes an answer in a confirmation window as using TIDAL for a while", () => {
		const gate = confirmGate();
		expect(gate.refuse({ tidal: FOCUSED, now: 0 })).toBe(undefined);
		gate.answered(true, 100);
		expect(gate.refuse({ tidal: AWAY, now: 100 + ANSWER_IN_USE_MS - 1 })).toBe(undefined);
		gate.answered(false, 200);
		expect(gate.refuse({ tidal: AWAY, now: 200 + ANSWER_IN_USE_MS })).toBe("TIDAL is not in use");
		// A window that was never shown is not an answer
		expect(gate.refuse({ tidal: FOCUSED, now: 300 })).toBe(undefined);
		gate.answered(undefined, 300);
		expect(gate.refuse({ tidal: AWAY, now: 200 + ANSWER_IN_USE_MS })).toBe("TIDAL is not in use");
	});

	it("stops taking the answer once the user leaves TIDAL", () => {
		const gate = confirmGate();
		expect(gate.refuse({ tidal: FOCUSED, now: 0 })).toBe(undefined);
		gate.answered(false, 0);
		gate.left();
		expect(gate.refuse({ tidal: AWAY, now: 1 })).toBe("TIDAL is not in use");
	});

	it("lets only a few wait at once", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_PENDING; i++) expect(gate.refuse({ tidal: FOCUSED, now: 0 })).toBe(undefined);
		expect(gate.refuse({ tidal: FOCUSED, now: 0 })!).toMatch(/already waiting/);
		gate.answered(true, 0);
		expect(gate.refuse({ tidal: FOCUSED, now: 0 })).toBe(undefined);
	});

	it("cools down after cancels in a row, an accept resets", () => {
		const gate = confirmGate();
		const ask = (now: number) => gate.refuse({ tidal: FOCUSED, now });
		for (let i = 0; i < MAX_CANCELS - 1; i++) {
			expect(ask(i)).toBe(undefined);
			gate.answered(false, i);
		}
		expect(ask(10)).toBe(undefined);
		gate.answered(true, 10);
		for (let i = 0; i < MAX_CANCELS; i++) {
			expect(ask(20 + i)).toBe(undefined);
			gate.answered(false, 20 + i);
		}
		expect(ask(100)!).toMatch(/cancelled in a row/);
		expect(ask(20 + MAX_CANCELS + COOL_DOWN_MS)).toBe(undefined);
	});

	it("doesn't count windows that were never shown", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_CANCELS * 2; i++) {
			expect(gate.refuse({ tidal: FOCUSED, now: i })).toBe(undefined);
			gate.answered(undefined, i);
		}
		expect(gate.pending).toBe(0);
	});

	it("doesn't count cancels long apart", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_CANCELS * 2; i++) {
			const now = i * (COOL_DOWN_MS + 1);
			expect(gate.refuse({ tidal: FOCUSED, now })).toBe(undefined);
			gate.answered(false, now);
		}
	});
});

describe("core confirmation page", () => {
	it("escapes what it shows", () => {
		const html = buildConfirmHtml({
			title: "<img src=x onerror=alert(1)>",
			lines: ['a "b" & </p><script>x()</script>'],
			confirmText: "<b>Go</b>",
		});
		expect(html.includes("<img src=x")).toBe(false);
		expect(html.includes("<script>x()")).toBe(false);
		expect(html.includes("<b>Go</b>")).toBe(false);
		expect(html.includes("&lt;img src=x onerror=alert(1)&gt;")).toBe(true);
	});

	it("starts with the confirm button disabled and Cancel focused", () => {
		const html = buildConfirmHtml({ title: "T", lines: [], confirmText: "Install" });
		// Armed by the window (data-arm, see NativeConfirm), Cancel never is
		expect(html).toMatch(/<button id="confirm" data-arm disabled>Install<\/button>/);
		expect(html).toMatch(/<button id="cancel">Cancel<\/button>/);
		expect(html).toMatch(/getElementById\("cancel"\)\.focus\(\)/);
	});

	it("checks requests that come over IPC", () => {
		expect(confirmRequest("T", ["a"], "Go")).toEqual({ title: "T", lines: ["a"], confirmText: "Go" });
		expect(() => confirmRequest(1, [], "Go")).toThrow();
		expect(() => confirmRequest("T", "a", "Go")).toThrow();
		expect(() => confirmRequest("T", [{}], "Go")).toThrow();
		expect(() => confirmRequest("", [], "Go")).toThrow();
		expect(() => confirmRequest("T", new Array(13).fill("a"), "Go")).toThrow();
		expect(confirmRequest("x".repeat(700), [], "Go").title.length).toBe(601);
	});
});
