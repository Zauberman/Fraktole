# Auto Compose Resilience: Resume, Progress, Summarize, Stop

## §1 Overview

Four verified friction points in the auto compose (autonomous reviewer) system:

1. **Destructive re-entry (F1)** — `startAutonomy` unconditionally re-forks; `forkProject` `rm -rf`s the existing fork first (fork.ts:37). Re-entering after a kill destroys the fork work area, while `state.json` (goal, sub-goals, tasks) still claims that progress. The model resumes in an empty fork with a lying ledger.
2. **No begin-vs-resume distinction (F2)** — the kick message is hardcoded "Begin the loop…" (reviewer.ts:490) even when a goal is already armed with pending sub-goals.
3. **No progress feedback (F3)** — between click and first model response (fork + 30-60s of research) there is no UI signal: no busy state, no activity line.
4. **No manual summarization (F4)** — the only context cleanup is `compactIfNeeded` (reviewer.ts:898), which drops exchanges with a generic "[context compacted: N exchanges dropped]" notice and never produces a summary.
5. **Silent ~90s resume (F5)** — after a kill, the loop re-kicks only via the watchdog after `GOAL_RECHECK_POLLS`(6) × 15s ≈ 90s of polling (reviewer.ts:527).
6. **Weak stop (F6)** — the stop button IPC handler calls `reviewer.cancel()` (main.ts:1000), which only aborts the in-flight provider call. It does NOT stop the watchdog, clear the queue, or set status — the reviewer stays `running` and can re-awaken.
7. **Stale explorer (F7)** — the left project tree fetches lazily on expand (Explorer.tsx:82) and re-loads the root only when the active project changes (Explorer.tsx:102-106). During an autonomous run, files and folders created by agents in the fork never appear until a manual collapse/re-expand.

This plan fixes all seven: fork preservation with a resume dialog, immediate resume kick, visible start-phase progress, a manual summarize+compact+persist action, a true full stop, and an auto-refreshing project explorer. All changes are backward-compatible.

## §2 Decisions Locked

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Fork lifecycle | Fork is the work area; user reviews it | No apply-back exists; agents deliver changes in the fork; the final report describes them. Re-entry must NEVER wipe a non-empty fork without consent. |
| D2 | Re-entry behavior | Resume in place, confirm once | Active goal + existing non-empty fork → no re-fork, resume kick, one confirmation dialog with [Resume in place] [Start fresh] [Cancel]. Fresh fork only when no prior run or explicit "Start fresh". |
| D3 | Summarize scope | Summarize + compact + persist recap | Model produces a session recap → injected into conversation → older exchanges dropped → recap persisted to `state.json` (`recap` field) and surfaced in the UI. Survives restarts. |
| D4 | Progress feedback | Button busy state + activity line | Auto compose button shows `forking…` → `planning…` until the first assistant message after start; activity line under the goal banner. |
| D5 | Resume after kill | Immediate resume kick | `doStart` pushes a resume wake right after load when the goal is active. Watchdog stays as the safety net. |
| D6 | Stop semantics | Full stop | Stop button = `reviewer.stop()`: abort + stopWatch + rejectPendingAsk + clear queue + status `stopped`. Goal/ledger/fork stay intact and resumable. |
| D7 | Recap display | Collapsible block under the goal banner | Reuses the existing goal-event pattern (`emit.recap` → `IPC.reviewerRecap` → `onReviewerRecap`). |
| D8 | Explorer refresh | Poll expanded dirs every 3s | Re-run `loadDir` for the active project root + all expanded dirs on an interval. NOT `fs.watch`: inotify watchers on trees up to 50k entries (fork cap) can exhaust watcher limits, and the fork is rebuilt (rm+copy) on fresh starts, which would burst change events. Polling is O(expanded dirs) cheap `listDir` calls with a change-guard to skip re-renders. |

Out of scope: apply-back of fork changes to src, per-variant per-fork history, model unloading (abort is the deepest available stop — the reviewer calls HTTP APIs, no model process to kill), watching the projects list itself (new sessions already appear via session events).

## §3 Architecture

### Component / module map

| File | Change |
|---|---|
| `src/shared/ipc.ts` | `ReviewerState.recap` field; new channels `reviewerSummarize`, `reviewerResumable`, `reviewerRecap`; `ReviewerRecapEvent` type |
| `electron/reviewer-state.ts` | `emptyState()` gains `recap: null` (load/persist untouched — whole-object JSON) |
| `electron/fork.ts` | `forkExists(dest)` export (isDirectory + non-empty); `forkProject(src, dest, home, keepExisting=false)` |
| `electron/reviewer.ts` | `startAutonomy(variant, mode)`; `resumableRun(variant)`; `doStart` resume wake; `summarizeSession()` + `pendingSummarize` + `captureMode` + recap persist/emit; `emit.recap` in opts interface |
| `electron/session-runtime.ts` | `ReviewerRuntime` interface: new signatures (`startAutonomy(variant, mode)`, `summarizeSession()`, `resumableRun()`) |
| `electron/main.ts` | `reviewerStop` → `stop()`; `reviewerAutonomy` accepts `mode`; new handlers `reviewerSummarize`, `reviewerResumable`; `emit.recap` → send `IPC.reviewerRecap` |
| `electron/preload.ts` | `setReviewerAutonomy(…, mode?)`, `summarizeReviewer`, `resumableRun`, `onReviewerRecap` |
| `src/components/ReviewerTab.tsx` | Busy state, activity line, resume dialog, summarize button, recap block |
| `src/components/Explorer.tsx` | Polling auto-refresh of the active project tree |
| `src/theme.css` | `.reviewer-activity`, `.reviewer-recap`, resume dialog, busy button |
| `tests/reviewer-loop.test.ts` | New tests (resume, fresh, summarize, doStart wake, stop) |
| `scripts/driver-e2e.mjs` | Smoke: no resume dialog without prior run (unchanged flow) |

### Data flows

**Re-entry with prior run:** variant click → `bridge.resumableRun(sessionId, variant)` → `{resumable, goalText}` → if resumable, dialog [Resume in place]/[Start fresh]/[Cancel] → `setReviewerAutonomy(sessionId, variant, 'auto'|'fresh')` → `startAutonomy(variant, mode)` → resumable ? (no re-fork, no re-arm, resume kick) : (fork + arm goal + begin kick).

**Kill + relaunch:** session opens → Reviewer tab visited → `ensureReviewer` → `start()` → `doStart` loads state/conversation → goal active → push `[resume]` wake → `drainQueue` → model continues immediately (seconds, not 90s).

**Summarize:** button → `reviewerSummarize` → `summarizeSession()` (deferred mid-turn) → queue `[summarize]` prompt → model reply captured → `state.recap` persisted + emitted → `compactIfNeeded(true)` drops older exchanges.

**Stop:** button → `reviewerStop` → `reviewer.stop()` → abort + watchdog off + queue cleared + status `stopped` (rendered immediately).

## §4 Phased Execution

### Phase 1: Recap state shape
Depends on: none
Files: `src/shared/ipc.ts`, `electron/reviewer-state.ts`
- `ReviewerState.recap?: { text: string; at: number } | null` (ipc.ts ~205)
- `emptyState()` returns `recap: null`
- New channel constants + `ReviewerRecapEvent { recap: { text, at } }` in ipc.ts

Acceptance:
- [ ] `RecapRecap` type compiles; `emptyState().recap === null`
- [ ] `loadState`/`persistState` round-trip a state with `recap` unchanged (whole-object JSON — no code change, covered by test)

### Phase 2: Fork preservation
Depends on: none
Files: `electron/fork.ts`
- `export async function forkExists(dest: string): Promise<boolean>` — directory AND at least one entry (`readdir` length > 0)
- `forkProject(src, dest, home, keepExisting = false)` — when `keepExisting && forkExists(dest)`, return `{ ok: true, path: dest }` immediately, before the `rm`. Default behavior unchanged.

Acceptance:
- [ ] `forkExists` true only for non-empty dirs, false for missing/empty/file
- [ ] `forkProject(..., keepExisting=true)` on an existing non-empty dest returns immediately without `rm`/copy (verify via spy/timing or content marker file surviving)
- [ ] `forkProject(..., keepExisting=false)` still wipes and rebuilds (existing tests still pass)

### Phase 3: Resume logic
Depends on: Phase 2
Files: `electron/reviewer.ts`, `electron/session-runtime.ts`, `electron/main.ts`, `electron/preload.ts`
- `ReviewerOpts.forkProject?: (variant, keepExisting: boolean) => Promise<ForkResult>`; main.ts wiring passes `keepExisting`
- `startAutonomy(variant, mode: 'auto'|'fresh' = 'auto')` — resume detection + conditional fork/arm/kick (key code §6)
- `resumableRun(variant): Promise<{ resumable, goalText }>`
- `doStart` resume wake: after `setStatus('running')`, if goal active push `[resume] continuing…` wake before `drainQueue()`
- `ReviewerRuntime` interface updated; IPC: `reviewerAutonomy(sessionId, variant, mode)`, `reviewerResumable(sessionId, variant)`; preload mirrors

Acceptance:
- [ ] Resumable state (active goal + existing non-empty fork): `startAutonomy` does NOT call `forkProject`, does NOT re-arm the goal, pushes a kick containing `resuming`; `setVariant` still called
- [ ] Fresh state: unchanged behavior (fork, arm mission, `Begin the loop` kick)
- [ ] `mode='fresh'` with resumable state: fork wiped and rebuilt
- [ ] `doStart` with active goal queues the `[resume]` wake; without goal queues nothing
- [ ] `resumableRun` returns correct flags for all four combinations

### Phase 4: Summarize session
Depends on: Phase 1
Files: `electron/reviewer.ts`, `electron/main.ts`, `electron/preload.ts`
- `summarizeSession()` — defer via `pendingSummarize` when not running/mid-turn/`captureMode` set; else queue the `[summarize]` prompt
- In `run()` turn-boundary (beside the existing `pendingCompact` handling, ~reviewer.ts:853-864): on capture completion persist `state.recap`, `emit.recap`, then `compactIfNeeded(true, true)`
- Early-exit path: `if (this.pendingSummarize && !this.running) this.summarizeSession()`
- `opts.emit.recap` wired in main.ts → `webContents.send(IPC.reviewerRecap, sessionId, recap)`
- IPC `reviewerSummarize` → `{ ok, error? }`; preload `summarizeReviewer`, `onReviewerRecap`

Acceptance:
- [ ] `summarizeSession()` while running defers; applied at next turn boundary
- [ ] Model reply captured into `state.recap`, persisted, emitted
- [ ] Older exchanges dropped after the recap (conversation ends at recap + goal block)
- [ ] Recap survives reload: `doStart`/`loadState` restores it (covered by test)

### Phase 5: Stop semantics
Depends on: none
Files: `electron/main.ts` (only)
- `reviewerStop` handler: `rt?.reviewer.cancel()` → `rt?.reviewer.stop()`
- `stop()` already does: `cancel()` + `stopWatch()` + `rejectPendingAsk()` + `queue = []` + `setStatus('stopped')` (reviewer.ts:355-361) — no reviewer.ts change needed

Acceptance:
- [ ] After stop: status `stopped` (rendered), queue cleared, watchdog dead, `pollNow` cannot revive (`status === 'stopped'` guard)
- [ ] Goal/ledger/fork intact → resumable (Phase 3 flow works after a stop)

### Phase 6: UI
Depends on: Phases 3, 4, 5
Files: `src/components/ReviewerTab.tsx`, `src/theme.css`
- Busy: `starting: 'forking'|'planning'|null`; set on variant click, `planning` after IPC resolves, `null` on first assistant message (existing `onReviewerMessage` subscription)
- Activity line under the goal banner: `forking…` / `planning…`
- Resume dialog state `resumeOffer: { variant, goalText } | null`; rendered as a `.dialog`-style small modal; buttons call `setReviewerAutonomy(id, 'auto'|'fresh')` or close
- "summarize session" button in the tools row (beside stop), busy while pending, error → existing `composeError` display
- Recap: `recap` state via `onReviewerRecap`; collapsible `.reviewer-recap` block under the goal banner with dismiss; pre-populated from initial state if present (via existing state fetch carrying `recap`)

Acceptance:
- [ ] Clicking a variant with no prior run: no dialog, direct start, button shows `forking…` then `planning…` until first assistant message
- [ ] Resumable run: dialog appears with the goal text; each of the three buttons behaves
- [ ] Summarize button: works, busy state, error surfaced; recap block appears after completion
- [ ] Stop button: status line shows `stopped`, prompt input disabled (`reviewer stopped — start revives it`), goal banner remains

### Phase 7: Explorer auto-refresh
Depends on: none (independent of Phases 1-6)
Files: `src/components/Explorer.tsx`
- Constant `EXPLORER_POLL_MS = 3000` in Explorer.tsx
- `loadDir` change-guard: skip `setDirs` when the fetched listing is identical to the cached one (same names in same order) — polling then causes zero re-renders when nothing changed
- Interval effect: when `treeOpen && activeProjectPath !== null`, every 3s call `loadDir(activeProjectPath)` + `loadDir(p)` for every path in `expanded`; clear the interval on unmount/close. `loadingRef` already de-duplicates an in-flight fetch against a poll tick

Acceptance:
- [ ] With the tree open, creating a file/dir on disk appears in the tree within ≤ poll interval + latency without any user action
- [ ] With the tree closed, no polling runs (no interval)
- [ ] Unchanged trees trigger no re-renders (change-guard returns the same Map reference)
- [ ] Deleted dirs collapse to an empty listing instead of crashing (existing `loadDir` catch)

### Phase 8: Tests + verification
Depends on: Phases 1-7
Files: `tests/reviewer-loop.test.ts`, `scripts/driver-e2e.mjs`
- Unit tests (mock `forkProject` recorder, tmp cwd): resume path (no fork call, `resuming` kick), fresh path (fork + `Begin the loop`), `mode='fresh'` re-fork, `resumableRun` 4 combinations, `doStart` wake queued/un-queued, `summarizeSession` deferral + recap persist/emit + compact drop, `stop()` full semantics (status, queue, watchdog, pollNow no-revive), state round-trip with `recap`
- Driver: auto compose section unchanged expectation (no resume dialog when no fork exists — verifies `resumableRun` returns false in the driver environment)

Acceptance:
- [ ] All existing tests pass (580+), new tests pass, `tsc -b` and lint clean
- [ ] DRIVER-E2E OK

## §5 File-by-File Breakdown

- **`src/shared/ipc.ts`** [MODIFIED] — `ReviewerState.recap`; channels `reviewerSummarize: 'reviewer:summarize'`, `reviewerResumable: 'reviewer:resumable'`, `reviewerRecap: 'reviewer:recap'`; `ReviewerRecapEvent` interface
- **`electron/reviewer-state.ts`** [MODIFIED] — `emptyState()` includes `recap: null`
- **`electron/fork.ts`** [MODIFIED] — add `forkExists`; add `keepExisting` param to `forkProject` (early return before `rm`)
- **`electron/reviewer.ts`** [MODIFIED] — import `forkExists` + `join`; opts interface `forkProject` signature; `emit.recap`; `startAutonomy(variant, mode)`; `resumableRun`; `doStart` resume wake; `summarizeSession` + `pendingSummarize` + `captureMode` + turn-boundary capture/compact
- **`electron/session-runtime.ts`** [MODIFIED] — `ReviewerRuntime` interface additions
- **`electron/main.ts`** [MODIFIED] — `reviewerStop` → `stop()`; `reviewerAutonomy` mode param + wiring `keepExisting`; new `reviewerSummarize`/`reviewerResumable` handlers; `emit.recap` sender
- **`electron/preload.ts`** [MODIFIED] — `setReviewerAutonomy(…, mode?)`, `summarizeReviewer`, `resumableRun`, `onReviewerRecap`
- **`src/components/ReviewerTab.tsx`** [MODIFIED] — busy state + activity line, resume dialog, summarize button, recap block
- **`src/components/Explorer.tsx`** [MODIFIED] — `EXPLORER_POLL_MS` constant; change-guard in `loadDir`; interval effect polling root + expanded dirs while the tree is open
- **`src/theme.css`** [MODIFIED] — `.reviewer-activity`, `.reviewer-recap`, dialog reuse, busy button
- **`tests/reviewer-loop.test.ts`** [MODIFIED] — new suites per Phase 7
- **`scripts/driver-e2e.mjs`** [MODIFIED] — minor: no-dialog expectation

## §6 Key Code Lines

### fork.ts
```ts
export async function forkExists(dest: string): Promise<boolean> {
  try {
    if (!(await stat(dest)).isDirectory()) return false;
    return (await readdir(dest)).length > 0;
  } catch {
    return false;
  }
}

export async function forkProject(src: string, dest: string, home: string, keepExisting = false): Promise<ForkResult> {
  // ...existing src/home checks unchanged...
  if (keepExisting && (await forkExists(dest))) return { ok: true, path: dest };
  // ...existing rm + clone/copy body unchanged...
}
```

### reviewer.ts — opts + emit surface
```ts
// interface ReviewerOpts (~line 95)
forkProject?: (variant: AutonomyVariant, keepExisting: boolean) => Promise<ForkResult>;
// interface ReviewerEmit (~line 66)
recap?(recap: { text: string; at: number }): void;
```

### reviewer.ts — startAutonomy with resume detection
```ts
async startAutonomy(variant: AutonomyVariant, mode: 'auto' | 'fresh' = 'auto'): Promise<{ ok: boolean; error?: string }> {
  if (!(await this.ensureStarted())) return { ok: false, error: 'reviewer not running' };
  const dest = join(this.opts.cwd, '.fraktole-auto', variant);
  const resumable = mode !== 'fresh' && this.state.goal?.state === 'active' && (await forkExists(dest));
  const fork = resumable
    ? { ok: true as const, path: dest }
    : await (this.opts.forkProject?.(variant, mode === 'fresh') ?? Promise.resolve({ ok: false as const, error: 'fork unavailable' }));
  if (!fork.ok) return { ok: false, error: fork.error };
  const cfg = await this.opts.getConfig();
  const mission =
    variant === 'custom'
      ? `Autonomous custom run: ${cfg.customAutonomy?.name?.trim() || 'custom'}`
      : AUTONOMY_MISSIONS[variant];
  await this.setVariant(variant);
  if (!resumable) await this.setGoal(mission);
  const kick: ProviderMsg = {
    role: 'user',
    announced: true,
    content: resumable
      ? `[autonomous mode] variant=${variant} — resuming the previous run in the existing fork at ${fork.path}. Verify the fork state first, then continue: finish the remaining sub-goals and tasks.`
      : `[autonomous mode] variant=${variant} — fork at ${fork.path}. ${mission} Begin the loop: spawn the read-only plan agent inside the fork and start researching.`,
  };
  this.queue.push(kick);
  this.opts.emit.message(toEntry(kick));
  this.drainQueue();
  return { ok: true };
}

async resumableRun(variant: AutonomyVariant): Promise<{ resumable: boolean; goalText: string | null }> {
  const active = this.state.goal?.state === 'active';
  const exists = await forkExists(join(this.opts.cwd, '.fraktole-auto', variant));
  return { resumable: active && exists, goalText: active ? this.state.goal!.text : null };
}
```

### reviewer.ts — doStart resume wake (insert after `setStatus('running')`, before `this.drainQueue()`)
```ts
const armed = this.state.goal !== null && this.state.goal.state === 'active';
if (armed) {
  this.queue.push({ role: 'user', content: this.withStateBlock('[resume] continuing the autonomous run — re-verify the fork and carry on') });
}
```

### reviewer.ts — summarizeSession
```ts
summarizeSession(): void {
  if (this.status !== 'running' || this.running || this.captureMode === 'summarize') {
    this.pendingSummarize = true; // applied at the next quiet boundary
    return;
  }
  this.pendingSummarize = false;
  this.captureMode = 'summarize';
  this.queue.push({
    role: 'user',
    content: this.withStateBlock(
      '[summarize] Produce a concise session summary: the goal, each sub-goal and its status, the task ledger, work completed so far, and what remains open. Under 300 words, plain text.',
    ),
  });
  this.drainQueue();
}
```

### reviewer.ts — turn boundary capture (beside pendingCompact handling ~line 853-864)
```ts
if (this.captureMode === 'summarize') {
  this.captureMode = null;
  const reply = /* the just-completed assistant turn's content in run() */;
  if (reply && reply.length > 0) {
    this.state.recap = { text: reply, at: Date.now() };
    await persistState(this.stateFile, this.state, this.opts.logger);
    this.opts.emit.recap?.(this.state.recap);
  }
  await this.compactIfNeeded(true, true);
}
// early-exit path addition:
if (this.pendingSummarize && !this.running) this.summarizeSession();
```

### main.ts
```ts
ipcMain.handle(IPC.reviewerStop, async (_e, sessionId: string): Promise<void> => {
  const rt = registry?.get(sessionId) ?? null;
  rt?.reviewer.stop(); // full stop: abort + watchdog off + queue cleared + status 'stopped'
});

ipcMain.handle(IPC.reviewerAutonomy, async (_e, sessionId, variant, mode = 'auto') => {
  // existing validation unchanged; call: rt.reviewer.startAutonomy(variant, mode === 'fresh' ? 'fresh' : 'auto')
});

ipcMain.handle(IPC.reviewerSummarize, async (_e, sessionId): Promise<{ ok: boolean; error?: string }> => {
  const rt = registry?.get(sessionId) ?? null;
  if (!rt) return { ok: false, error: 'session not found' };
  rt.reviewer.summarizeSession();
  return { ok: true };
});

ipcMain.handle(IPC.reviewerResumable, async (_e, sessionId, variant) => {
  const rt = registry?.get(sessionId) ?? null;
  if (!rt) return { resumable: false, goalText: null };
  return rt.reviewer.resumableRun(variant);
});
```

### preload.ts
```ts
setReviewerAutonomy: (sessionId, variant, mode = 'auto') =>
  ipcRenderer.invoke(IPC.reviewerAutonomy, sessionId, variant, mode),
summarizeReviewer: (sessionId): Promise<{ ok: boolean; error?: string }> =>
  ipcRenderer.invoke(IPC.reviewerSummarize, sessionId),
resumableRun: (sessionId, variant): Promise<{ resumable: boolean; goalText: string | null }> =>
  ipcRenderer.invoke(IPC.reviewerResumable, sessionId, variant),
onReviewerRecap: (sessionId, cb): (() => void) => { /* ipcRenderer.on(IPC.reviewerRecap) mirror of onReviewerGoal */ },
```

### ReviewerTab.tsx
```ts
const [starting, setStarting] = useState<'forking' | 'planning' | null>(null);
const [resumeOffer, setResumeOffer] = useState<{ variant: AutonomyVariant; goalText: string } | null>(null);
const [recap, setRecap] = useState<{ text: string; at: number } | null>(null);

const pickVariant = async (id: AutonomyVariant): Promise<void> => {
  setAutonomyOpen(false);
  setStarting('forking');
  const r = await bridge.resumableRun(sessionId, id);
  if (r.resumable) { setStarting(null); setResumeOffer({ variant: id, goalText: r.goalText ?? '' }); return; }
  setStarting('planning');
  await bridge.setReviewerAutonomy(sessionId, id, 'auto');
};
// onReviewerMessage: first entry.role === 'assistant' after a start clears `starting`
// activity line: {starting && <div className="reviewer-activity">{starting}…</div>}
// resume dialog: [Resume in place] → setReviewerAutonomy(id, 'auto') · [Start fresh] → setReviewerAutonomy(id, 'fresh') · [Cancel] → close
// summarize button: busy state + bridge.summarizeReviewer(sessionId) + error via composeError
// recap block: {recap && <div className="reviewer-recap">…</div>} + dismiss
```

### Explorer.tsx — polling auto-refresh
```ts
const EXPLORER_POLL_MS = 3000;

// inside loadDir, after `const entries = await bridge.listDir(path);`:
setDirs((prev) => {
  const cur = prev.get(path);
  if (
    cur &&
    cur.length === entries.length &&
    cur.every((e, i) => e.name === entries[i].name && e.isDir === entries[i].isDir)
  ) {
    return prev; // unchanged — polling must not re-render
  }
  return new Map(prev).set(path, entries);
});

// interval effect (replace/augment the activeProjectPath effect):
useEffect(() => {
  if (activeProjectPath === null || !treeOpen) return;
  const id = setInterval(() => {
    void loadDir(activeProjectPath);
    for (const p of expanded) void loadDir(p);
  }, EXPLORER_POLL_MS);
  return () => clearInterval(id);
}, [activeProjectPath, treeOpen, expanded, loadDir]);
```

## §7 Risks & Open Questions

| Risk | Likelihood | Mitigation |
|---|---|---|
| Double kick: `doStart` resume wake + `startAutonomy` resume kick both fire when the user re-enters manually after restart | High but harmless | Both prompts are consistent ("continue"); model treats the second as a re-check. No dedup in v1. |
| `stop()` clears the queue — unsent prompts dropped | Low | Stop is a hard stop by design; announced transcript entries remain visible. |
| Stale/partial existing fork resumed in place | Low | `forkExists` requires non-empty; forkProject cleans partials on failure (existing behavior). Resume kick instructs the model to verify fork state first. |
| Recap exceeds budget | Medium | Prompt caps at 300 words; compactIfNeeded(force) still trims to budget. |
| Auto-resume after an explicit stop + relaunch | Medium | Consistent with the watchdog's "never let a goal silently die" design; the goal banner makes the armed state visible. Accepted default. |
| Explorer polling IO cost | Low | O(expanded dirs) `listDir` calls every 3s; change-guard skips re-renders; in-flight de-dup via `loadingRef`; polling stops when the tree is closed. Big directories under a deep expanded chain are the only cost and listDir is a single readdir. |
| Polling misses events outside expanded dirs (new nested dirs only appear when their parent is expanded) | Accepted | The fork's agent-created files live in already-expanded locations the user is watching; collapse/re-expand or the 3s tick on the root covers the rest. |

Open questions (defaults chosen, revisit only if user objects):
- Resume kick wording ("[resume] continuing the autonomous run…") — generic for both kill-restart and manual restart-after-stop. Default accepted.
- Recap block: collapsible via details/summary-style toggle. Default accepted.

## §8 Verification Strategy

**Static:** `npx tsc -b` (zero errors), `npx eslint` (clean), `npx vitest run` (all suites incl. new).

**Unit (new in `tests/reviewer-loop.test.ts`):** resume detection matrix; fork preservation (marker file survives `keepExisting`); `mode='fresh'` wipe; `doStart` wake; summarize deferral/capture/persist/compact; stop semantics (status/queue/watchdog/`pollNow` no-revive); `recap` state round-trip.

**Driver:** extend the auto compose section — best-effort explorer check: when a project tree is visible, create a file in the active project, wait ≤ 6s, assert the tree row appears (skipped silently when no project tree is bound in the driver environment).

**Runtime (user commands, after build + driver):**
1. `npx kill-port 5173 9223; node scripts/driver-e2e.mjs` → DRIVER-E2E OK
2. Start an auto compose run, kill the app mid-run, relaunch → open Reviewer tab → transcript shows `[resume] continuing…` within seconds; goal banner + sub-goals intact
3. Click auto compose → resume dialog with goal text → "Resume in place" → no re-fork (fork mtime/content unchanged), kick says "resuming"
4. "Start fresh" → fork wiped and rebuilt
5. "summarize session" → busy, then recap block appears; `state.json` contains `recap`; conversation truncated to recap
6. Stop during a run → status `stopped`, prompt disabled, no revival after 2 minutes of inactivity
7. During an active run, watch the explorer: files created by agents in the fork appear within ~3s with no user action
