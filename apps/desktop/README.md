# Fraktole Desktop — Engineering Notes

App-level engineering log. The product README lives at the repo root.

## Failure Threads

### Backend
- [2026-09-03 14:10] TYPE ERROR: `electron/main.ts` — TS18047: never-returning `refuse` arrow did not narrow `rt`/`session`. Fixed by returning `Error` from the helper and `throw refuse(...)` at each guard.
- [2026-09-03 14:25] TYPE ERROR: `electron/pty-host.ts:106` — TS2322 `undefined` not assignable to `Timeout | null` in the double-kill timer guard. Fixed with `null`.
- [2026-09-03 14:40] TYPE ERROR: `electron/mailbox.ts` — TS2663 `quarantine` referenced without `this.` in two call sites. Fixed.
- [2026-09-03 15:05] TYPE ERROR: orphan-channel removal left `SendMessageArgs`/`SessionSnapshot`/`FraktoleMessage` imports dangling in `main.ts`, `src/ipc.ts`, `preload.ts`. Fixed by stripping the imports and the dead handlers.

### Frontend
- [2026-09-03 14:55] LINT: `src/App.tsx` unused `AUTONOMY_NAMES` after the dead-conditional fix. Fixed by removing the import.

### Testing
- [2026-09-03 15:30] RUNTIME ERROR: driver-e2e tightened row-color assertion exposed a sampling artifact — `.reviewer-item-tool` matched the error card first, so tool and error samples read the same element. Fixed with `:not(.reviewer-item-tool-error)` and a null-safe `mk` helper.
- [2026-09-03 15:35] RUNTIME ERROR: same assertion then flagged user/tool bodies sharing `--text` — verified as intentional design (role labels and the tool band carry the distinction); assertion relaxed to the real contract (error tinted apart from tool).
- [2026-09-03 15:50] RUNTIME ERROR: `tests/session-bundle.test.ts` — import test hit ENOENT because `touchSessionIndex` conflated a missing index with a corrupt one. Fixed: ENOENT creates the index, corrupt leaves it for the store's quarantine path.

### Other
- [2026-09-03 15:20] CONFIG ERROR: `scripts/make-installer.sh` — string replace broke an `echo` quote pair. Fixed and verified with `bash -n`.
