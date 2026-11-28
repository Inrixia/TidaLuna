# Verifying findings

Run per finding. Findings are independent until proven otherwise. Read-only: experiments and reproductions go in a scratch dir outside the repo, never in project files.

## Process

1. Read the code the finding points at, in the current version. Generated findings often cite shifted lines, misread control flow, or describe code that does not exist. A claim that does not survive the file is settled.
2. Build the concrete failure scenario: inputs and state that produce the wrong output, crash or exposure. Cannot construct one: strong false-positive signal; say which step failed.
3. Try to refute it, from distinct angles: does it reproduce (write a throwaway test or script), does control flow allow it (guards upstream, types, framework guarantees), which invariant would it break, is the input reachable from outside.
4. Test "an earlier fix caused this": check `git log -p` / `git blame` on the lines. A fix that resolved one symptom and introduced this one changes what the right fix is.
5. `CONFIRMED`: argue severity (small or big, and why), then blast radius: callers, invariants and assumptions a correction touches, and what new defect it could introduce.
6. Still unresolved: reframe the question and try another angle. Do not lower the bar to close it. Truly blocked: escalate the exact unknown.

## Verdict format

```
FINDING:      <claim, one line>
VERDICT:      CONFIRMED | FALSE POSITIVE
EVIDENCE:     <code path, scenario, or the refutation that failed / succeeded>
SEVERITY:     <small | big, argued>                         (CONFIRMED only)
BLAST RADIUS: <what a fix touches, what it could break>      (CONFIRMED only)
```

Cannot decide: `Cannot conclude whether <X> without <Y>. Decide, or give me <Y>.`

## Responding to a reviewer

- Restate the technical claim in your own words to check you understood it; ask if unclear rather than guess.
- Agree only after verifying; disagree with the evidence (code path, test, doc link). Being polite is fine; being agreeable instead of correct is not.
- Suggestion conflicts with the user's earlier decisions or repo conventions: raise the conflict, do not silently pick one.
- YAGNI check on "while you're here" requests: is it needed for this change? If not, propose it separately.
- Fixing several findings: one at a time, test after each, in severity order.

## Red flags: the investigation is not finished

- Any verdict other than `CONFIRMED` / `FALSE POSITIVE`.
- A verdict with no constructible scenario behind it.
- Accepting or dismissing because of who or what produced the finding.
- Skipped "did an earlier fix cause this?".
- `CONFIRMED` without blast radius.
- Editing project code during verification, or starting a fix the user did not ask for.
