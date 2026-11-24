# lib.native helpers work across the bridge

Requires: none

`*.native.ts` code runs in the main process and is called from the page over IPC. Check the real round trip.

1. `start`.
2. Read `plugins/lib.native/src` and pick its read-only helpers (things that report state or read files under the TIDAL install or temp dir; skip anything that writes, downloads or opens windows).
3. Call each from the page: `eval 'luna.native.<fn>(<args>)'`, and the same function in the main process: `native 'luna.modules[<file>].<fn>(<args>)'` (find the key with `native 'Object.keys(luna.modules)'`).
4. Pass an argument that can't be structured-cloned (a function) to one helper and see the error is reported, not a hang.

Pass when page and main process give the same results and step 4 rejects within a few seconds.
