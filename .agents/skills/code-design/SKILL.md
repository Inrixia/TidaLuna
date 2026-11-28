---
name: code-design
description: House code design and smells - reuse, ownership, construction, errors, file layout, naming, tests. Language-agnostic. Use when writing, refactoring or reviewing code, or before adding a function, class, file or helper.
---

# Code design

How code is reviewed. Apply to new code and to code you touch. The repo's `AGENTS.md` and existing conventions win on conflict; language specifics live in the language skills.

## Design

- Reuse before writing: search the repo and installed dependencies first. If something almost fits, extend it; don't write a near-duplicate or hand-roll a mechanic that already has an owner.
- Generic code lives in its owning layer and is exported for reuse. Feature code keeps only feature logic.
- Each value has one owner; others ask it rather than keep a copy that can disagree. A function that uses a class's state lives on that class.
- Classes keyed by identity (url, path, id): `static from(...)` with a private constructor, instances cached in a static map named for what it holds (`Apple.apples`). Same key, same instance.
- Constructors validate: throw on state that should not exist.
- A function that fails throws; one whose value is known to be absent returns `undefined`/`None`. No `{ ok, error }` bags: errors propagate until something can handle them.
- Public state beats accessor ceremony. Pass a value once; if the callee already holds it, read it from there.
- Cache a derived value only when the cost is real.
- Inline a function called once, unless that bloats the file. Extract only what is large or generic enough to reuse: `Class.stepName.ts` beside the class, `stepName.ts` for a standalone helper.
- One class per file, named for its role. A class spanning several files gets a folder.
- A file over 200 lines holding more than one function is worth splitting.
- Await what you start. Feature-detect platform APIs that may be missing.

## Smells to fix rather than add

- A third copy of the same logic: extract it into the owning layer and call it from every site.
- An export nobody imports; a wrapper that only forwards arguments.
- A raw platform API where a repo helper exists.
- Type escape hatches covering a mismatch (`any`, `as`, `unwrap` on input that can fail), unused parameters, dead or commented-out code, a `TODO` with no issue.
- A `catch` that loses an error by accident. Turning an error into `undefined` on purpose is fine.
- Listeners, timers, subscriptions or handles with no cleanup path.
- Comments that narrate the code. Say why.

## Names and tests

- Names say what a thing is for.
- Uncertain input is `unknown`, then narrowed.
- Fixes and features come with a test. A test's name is the bug it prevents.
