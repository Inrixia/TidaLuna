# Debugging and fixing at the source

## 1. Get a signal

- Reproduce first. Best: a failing automated test at the lowest level that shows the bug. Otherwise a script or command with a clear pass/fail exit.
- Make it fast and deterministic: fix seeds, fake time, stub network, shrink the input. A flaky repro is not a repro; loop it (`for i in $(seq 50)`) to measure the failure rate before and after.
- Read the actual error, stack and logs top to bottom before theorizing. Redact secrets before pasting logs anywhere.

## 2. Find the cause

- One hypothesis at a time; predict what you will see, then check. Change one variable at a time.
- Regression with a known good version: `git bisect run <test command>`.
- Narrow by halving: comment out / bypass half the path, binary search the input, compare a working and failing environment (versions, config, data, OS).
- Instrument at boundaries (inputs and outputs of each layer) rather than everywhere. Remove instrumentation after.
- Check what changed: recent commits, dependency upgrades (lockfile diff), config, environment, data.
- Ascend: the crash site is evidence, not the target. Ask "why does this state exist?" repeatedly until the answer is outside the system. That origin is where the fix goes.
- Search for the same cause elsewhere: every caller of the faulty function, every copy of the faulty pattern.
- Dependency bug suspected: read its changelog, issues and source (clone to a scratch dir). Known upstream fix: upgrade or apply the documented workaround, and cite it.

## 3. Fix

- Fix the whole failure class at the origin, in shared code, aligned with the existing architecture. Not the triggering case only.
- Smallest complete change: every caller, test and fixture the fix touches, nothing unrelated.
- No TODO, "temporary", "for now", or follow-up-ticket in place of the real fix.
- Risky but correct general fix: give it a rollout mechanism (flag, staged deploy), never a hardcoded special case.
- Two defensible candidate fixes: build both in scratch, compare on correctness and cost, keep the winner, say why.

## 4. Prove

- The regression test fails before the fix and passes after. Keep it.
- Run the nearest affected suite plus typecheck/lint.
- State in one line why the failure class cannot recur (the deterministic argument). "Passed 20 runs" shows rarer, not gone.
- Report: cause, fix, evidence (command and result). No completion claim without fresh output from this session.

## Band-aids

Only when an incident forces mitigation first: mark it `BAND-AID` in a code comment and in your message, then continue to the source fix in the same session. A band-aid may be final only when the source is unreachable (external system, unfixed upstream bug): say so and get sign-off.

## Red flags: you are hiding a symptom

- `sleep`, delay or retry added so timing "settles".
- A guard at the crash site as the entire fix.
- A condition naming a specific customer, host, environment or test.
- `try/catch` (or `.catch`, `let _ =`, `unwrap_or_default`) that swallows or downgrades an error.
- Disabling, skipping or loosening a test, lint rule or type check.
- "temporary", "for now", "TODO: revisit".
- Declaring done while the upstream cause still produces bad state.
- Choosing between fixes on intuition instead of a measurement.

Each means: stop, ascend the causal chain, fix the source.
