import assert from "node:assert";
import { describe, it } from "node:test";

import {
	ANSWER_IN_USE_MS,
	buildChoiceHtml,
	buildConfirmHtml,
	confirmGate,
	confirmRequest,
	fitLines,
	focusedWithin,
	isHostAnswer,
	type FocusTarget,
	COOL_DOWN_MS,
	MAX_CANCELS,
	MAX_PENDING,
	type TidalState,
} from "./confirmPage";

const FOCUSED: TidalState = { visible: true, focused: true, recentUserInput: false };
const AWAY: TidalState = { visible: true, focused: false, recentUserInput: false };

describe("host questions", () => {
	it("never cool down after denies, only after closes", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_CANCELS * 2; i++) {
			assert.equal(gate.refuse({ tidal: FOCUSED, now: i }), undefined);
			gate.answered(isHostAnswer("choice:deny"), i);
		}
		for (let i = 0; i < MAX_CANCELS - 1; i++) {
			assert.equal(gate.refuse({ tidal: FOCUSED, now: 100 + i }), undefined);
			gate.answered(isHostAnswer("close"), 100 + i);
		}
		assert.equal(gate.refuse({ tidal: FOCUSED, now: 200 }), undefined);
		gate.answered(isHostAnswer("close"), 200);
		assert.match(gate.refuse({ tidal: FOCUSED, now: 201 })!, /cancelled in a row/);
	});

	const fakeWindow = (focused = false) => {
		const listeners = new Map<string, Set<() => void>>();
		const win: FocusTarget & { emit(event: string): void; listening(): number } = {
			isDestroyed: () => false,
			isFocused: () => focused,
			on: (event, listener) => listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
			off: (event, listener) => listeners.get(event)?.delete(listener),
			emit: (event) => [...(listeners.get(event) ?? [])].forEach((listener) => listener()),
			listening: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
		};
		return win;
	};

	it("wait for TIDAL's focus: at once, on focus, or not after a close or the time", async () => {
		assert.equal(await focusedWithin(fakeWindow(true), 10), true);
		const later = fakeWindow();
		const focused = focusedWithin(later, 1000);
		later.emit("focus");
		assert.equal(await focused, true);
		assert.equal(later.listening(), 0);
		const closing = fakeWindow();
		const closed = focusedWithin(closing, 1000);
		closing.emit("closed");
		assert.equal(await closed, false);
		assert.equal(await focusedWithin(fakeWindow(), 5), false);
	});
});

describe("core confirmation gate", () => {
	it("refuses while TIDAL is not in use", () => {
		const gate = confirmGate();
		assert.equal(gate.refuse({ tidal: AWAY, now: 0 }), "TIDAL is not in use");
		assert.equal(gate.pending, 0);
	});

	it("takes recent input in TIDAL when focus isn't reported, but never a hidden TIDAL", () => {
		const gate = confirmGate();
		assert.equal(gate.refuse({ tidal: { ...AWAY, recentUserInput: true }, now: 0 }), undefined);
		assert.equal(gate.refuse({ tidal: { visible: false, focused: true, recentUserInput: true }, now: 0 }), "TIDAL is not in use");
	});

	it("takes an answer in a confirmation window as using TIDAL for a while", () => {
		const gate = confirmGate();
		assert.equal(gate.refuse({ tidal: FOCUSED, now: 0 }), undefined);
		gate.answered(true, 100);
		assert.equal(gate.refuse({ tidal: AWAY, now: 100 + ANSWER_IN_USE_MS - 1 }), undefined);
		gate.answered(false, 200);
		assert.equal(gate.refuse({ tidal: AWAY, now: 200 + ANSWER_IN_USE_MS }), "TIDAL is not in use");
		// A window that was never shown is not an answer
		assert.equal(gate.refuse({ tidal: FOCUSED, now: 300 }), undefined);
		gate.answered(undefined, 300);
		assert.equal(gate.refuse({ tidal: AWAY, now: 200 + ANSWER_IN_USE_MS }), "TIDAL is not in use");
	});

	it("stops taking the answer once the user leaves TIDAL", () => {
		const gate = confirmGate();
		assert.equal(gate.refuse({ tidal: FOCUSED, now: 0 }), undefined);
		gate.answered(false, 0);
		gate.left();
		assert.equal(gate.refuse({ tidal: AWAY, now: 1 }), "TIDAL is not in use");
	});

	it("lets only a few wait at once", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_PENDING; i++) assert.equal(gate.refuse({ tidal: FOCUSED, now: 0 }), undefined);
		assert.match(gate.refuse({ tidal: FOCUSED, now: 0 })!, /already waiting/);
		gate.answered(true, 0);
		assert.equal(gate.refuse({ tidal: FOCUSED, now: 0 }), undefined);
	});

	it("cools down after cancels in a row, an accept resets", () => {
		const gate = confirmGate();
		const ask = (now: number) => gate.refuse({ tidal: FOCUSED, now });
		for (let i = 0; i < MAX_CANCELS - 1; i++) {
			assert.equal(ask(i), undefined);
			gate.answered(false, i);
		}
		assert.equal(ask(10), undefined);
		gate.answered(true, 10);
		for (let i = 0; i < MAX_CANCELS; i++) {
			assert.equal(ask(20 + i), undefined);
			gate.answered(false, 20 + i);
		}
		assert.match(ask(100)!, /cancelled in a row/);
		assert.equal(ask(20 + MAX_CANCELS + COOL_DOWN_MS), undefined);
	});

	it("doesn't count windows that were never shown", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_CANCELS * 2; i++) {
			assert.equal(gate.refuse({ tidal: FOCUSED, now: i }), undefined);
			gate.answered(undefined, i);
		}
		assert.equal(gate.pending, 0);
	});

	it("doesn't count cancels long apart", () => {
		const gate = confirmGate();
		for (let i = 0; i < MAX_CANCELS * 2; i++) {
			const now = i * (COOL_DOWN_MS + 1);
			assert.equal(gate.refuse({ tidal: FOCUSED, now }), undefined);
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
		assert.equal(html.includes("<img src=x"), false);
		assert.equal(html.includes("<script>x()"), false);
		assert.equal(html.includes("<b>Go</b>"), false);
		assert.equal(html.includes("&lt;img src=x onerror=alert(1)&gt;"), true);
	});

	it("starts with the confirm button disabled and Cancel focused", () => {
		const html = buildConfirmHtml({ title: "T", lines: [], confirmText: "Install" });
		assert.match(html, /<button id="confirm" disabled>Install<\/button>/);
		assert.match(html, /getElementById\("cancel"\)\.focus\(\)/);
		// Main disarms it while another window has the focus
		assert.match(html, /window\.disarm = \(\) => \(confirmButton\.disabled = true\)/);
	});

	it("checks requests that come over IPC", () => {
		assert.deepEqual(confirmRequest("T", ["a"], "Go"), { title: "T", lines: ["a"], confirmText: "Go" });
		// Luna's own lines past the limit go into the last one instead of failing the window
		const many = Array.from({ length: 14 }, (_, i) => `l${i}`);
		// Short lines share one, so no text is cut
		assert.deepEqual(fitLines(many), [many.join(" ")]);
		const long = Array.from({ length: 14 }, (_, i) => `${i}`.padEnd(400, "x"));
		assert.deepEqual(fitLines(long), [...long.slice(0, 11), long.slice(11).join(" ")]);
		assert.equal(confirmRequest("T", fitLines(long), "Go").lines.length, 12);
		assert.deepEqual(fitLines(["a"]), ["a"]);
		assert.throws(() => confirmRequest(1, [], "Go"));
		assert.throws(() => confirmRequest("T", "a", "Go"));
		assert.throws(() => confirmRequest("T", [{}], "Go"));
		assert.throws(() => confirmRequest("", [], "Go"));
		assert.throws(() => confirmRequest("T", new Array(13).fill("a"), "Go"));
		assert.equal(confirmRequest("x".repeat(700), [], "Go").title.length, 601);
	});
});

describe("core choice page", () => {
	const choices = [
		{ id: "deny", label: "Deny" },
		{ id: "once", label: "Only <now>" },
		{ id: "always", label: "Always allow" },
	];
	it("draws the first choice as cancel, the last as the main button, all disarmed and none focused", () => {
		const html = buildChoiceHtml({ title: "Allow?", lines: ["x"], confirmText: "-", choices });
		assert.match(html, /<button class="choice" data-id="deny" id="cancel" disabled>Deny<\/button>/);
		assert.match(html, /document\.body\.focus\(\)/);
		assert.equal(html.includes('getElementById("cancel").focus()'), false);
		assert.match(html, /<button class="choice" data-id="once" disabled>Only &lt;now&gt;<\/button>/);
		assert.match(html, /<button class="choice" data-id="always" id="confirm" disabled>Always allow<\/button>/);
		assert.match(html, /submit\("choice:" \+ button\.dataset\.id\)/);
		assert.match(html, /event\.key === "Escape" && submit\("no"\)/);
		// One set of buttons, one script
		assert.strictEqual(html.match(/<script>/g)?.length, 1);
		assert.strictEqual(html.includes(">Cancel<"), false);
		assert.ok(html.includes(".choice:disabled"));
	});
	it("refuses bad choice ids and fewer than two choices", () => {
		assert.throws(() => buildChoiceHtml({ title: "T", lines: [], confirmText: "-", choices: [{ id: "a", label: "A" }] }));
		assert.throws(() =>
			buildChoiceHtml({
				title: "T",
				lines: [],
				confirmText: "-",
				choices: [
					{ id: "a", label: "A" },
					{ id: 'b" onclick="x', label: "B" },
				],
			}),
		);
	});
});
