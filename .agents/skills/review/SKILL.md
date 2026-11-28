---
name: review
description: Code review and fixing - review a diff/PR/branch, verify review comments or findings before acting, debug and fix defects at the root cause. Use when asked to review code or a PR, when review comments, lint, static-analysis or security findings arrive, when debugging a bug or failing test, or when tempted to patch a symptom.
---

# Review

Three modes. Pick by the request; they chain (review, then verify, then fix) only when asked.

## Mode 1: Reviewing code

1. Scope: get the exact diff (`git diff <base>...HEAD`, `gh pr diff <n>`) and the intent (PR body, issue, spec, user request). No intent available: ask, or review for correctness only.
2. Read beyond the hunks: callers, callees, types, tests, config the change relies on. Most real bugs sit at the boundary of the diff.
3. Two passes: (a) correctness against intent: does it do what it claims, for all inputs, states and error paths; (b) standards: repo conventions, simplicity, tests, security. Checklist: `references/checklist.md`.
4. Report only what you can back: a concrete failure scenario (inputs or state, then the wrong result) or a specific violated convention. Re-read the code before reporting each finding. Unsure and unable to settle it: ask it as a question, never a hedged finding.
5. Output, most severe first, one block per finding:
   `path:line` | blocker / should-fix / nit | claim | failure scenario | suggested fix.
   "No issues found" is a valid result. No praise padding, no restating the diff. Label nits optional and keep them few.
6. Reviewing does not edit code unless the user asked for fixes.

## Mode 2: Receiving findings (any source: reviewer, user, linter, scanner, another agent, yourself)

- A finding is a claim, not a fact. Verify each against the current code before acting. Provenance is not evidence.
- Verdict per finding: `CONFIRMED` or `FALSE POSITIVE`. No "plausible", "likely", "worth watching". Cannot decide: name the single unknown blocking you and ask.
- Always test "did a recent change or an earlier fix cause this?".
- `CONFIRMED` gets severity and blast radius (callers, invariants and behavior a fix would touch).
- No performative agreement ("great catch", "you're absolutely right"). Disagree with evidence, including with the user. Implement suggestions you verified, not ones you were told.
- Assessment only requested: present verdicts and stop. Asked to address the comments: fix confirmed ones (Mode 3), reply to false positives with the evidence.
- Process and verdict format: `references/findings.md`.

## Mode 3: Debugging and fixing

- No fix without a known root cause. Get a fast, deterministic pass/fail signal first (failing test preferred), then hypothesize, bisect, instrument. One variable at a time.
- Ascend from the symptom: ask why the bad state exists until the answer leaves the system. Fix there, once, for the whole failure class; find every other site the same cause reaches.
- Known upstream bug: upgrade or use the official workaround; cite the issue, changelog or docs.
- Prove it: regression test fails before and passes after, nearest suite green, and a one-line reason the failure class is gone. N green runs is not proof for flaky or timing bugs.
- Smallest complete diff. No drive-by refactors; mention them separately.
- Forced mitigation: label `BAND-AID` in code and in your message, then fix the source in the same session, or say why the source is unreachable and get sign-off.
- Process, debugging techniques and red flags: `references/fixing.md`.

## References

- `references/checklist.md`: read when reviewing (what to look for, by category).
- `references/findings.md`: read when verifying findings or review comments.
- `references/fixing.md`: read when debugging or about to write a fix.
