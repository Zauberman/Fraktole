# Plan: Tool Wiring Audit — Full Fix

## §1 Overview

Fix the six tool failures from the model's retrospective at their true roots in Fraktole's wiring: stale `read_scrollback` (persisted only at session-save time, up to 30s lag), silent `(empty)`/`(no matches)` false negatives from `read_tile` and `search_files`, and agent results queueing FIFO behind long orchestrator turns. No changes to the mailbox echo mechanism (user decision). Harness-side stalls (`Thinking`, `/compact` ack) are covered by the now-reliable tails plus the existing 120s stall watchdog and `kill_agent`.

## §2 Decisions Locked

| Decision | Choice | Why |
|---|---|---|
| `search_files` on a file path | Accept single file, search it; error only on missing path | Matches model expectation; kills the false negative |
| `read_scrollback` freshness | Live recorder first (zero lag) + disk fallback, AND main-process incremental flush (debounced) of the recorder to the scrollback files | Reviewer gets zero-lag; restart/remote/phone get ~1s-fresh files |
| Result preemption | `onAgentMessage` sets `pendingInterrupt` when `kind === 'result'` and a turn is running; notes stay FIFO | A completed verdict must not wait out a 25-iteration turn |
| `send_message` echo | Status quo, no mechanism change | User decision: the model's responsibility to ensure the harness is running before sending |
| Harness stall / compact ack | No new mechanism; covered by fresh tails + existing watchdog + `kill_agent` | Confirmed scope |
| Ship | Version 0.12.6, build + install + commit + push at the end | Established pattern |

## §3 Architecture

**Output flow (after this plan):**
```
PTY → PtyHost.onData → enqueueChunk (coalesce/setImmediate) → flushTile
   → recorder.record(tileId, data)      [existing]
   → persist.note(tileId)               [NEW: 1s debounce → scrollback/<agentId>.json, tmp+rename]
   → renderer IPC / remote publish      [existing]
tileExit → flushTile → persist.flushTile(tileId, lines) [NEW, before recorder.drop]
```

**Read paths (tool layer):**
- `read_tile`: recorder only, with hardened `resolveTile` (agent-id-in-tileId-field fallback, clear errors, "no live recording yet" hint).
- `read_scrollback`: `ctx.tileOfAgent(agentId)` → if recorder has data, return the live ring; else read `<sessionDir>/scrollback/<agentId>.json` (now ~1s fresh).

**Message flow:**
```
send_message → router.sendFromOrchestrator → deliver (inbox file + jsonl + PTY echo [UNCHANGED])
  → emit → reviewer.onAgentMessage → queue.push + [NEW] pendingInterrupt=true for results
  → run() yields at next tool boundary (existing mechanism, now also triggered by results)
```

**Contracts:**
- `ScrollbackPersist` (new module): `note(tileId)`, `flushTile(tileId, lines)`, `dispose()`.
- `resolveTile`: returns real tileId, or `null` (unknown) — never a silently-unknown key.
- `pendingInterrupt`: now settable from `prompt()` (existing) and `onAgentMessage` (results only).

## §4 Phased Execution

### Phase 1: Tool-layer fixes — `search_files`, `read_tile`, `read_scrollback`
**Depends on:** none
**Files modified:** `electron/reviewer-tools.ts`, `tests/reviewer-tools.test.ts`

1. `searchFiles()`: `stat(abs)` before walking — file → `searchSingleFile()`, dir → existing walk, stat throws → `error: path not found`. Inner `readdir` catch stays as a guard.
2. `resolveTile()`: if `tileId` given, use it only when `ctx.recorder.has(tileId)`; else try `ctx.agentOfTile(tileId)`; `agentId` field → `ctx.tileOfAgent`.
3. `read_tile`: unknown tile → error; known tile with no live data → `no live recording yet` hint; grep on live-but-no-match keeps `(no matches)`.
4. `read_scrollback`: live recorder first, disk file fallback.
5. Update tool descriptions.

### Phase 2: Agent results preempt the running turn
**Depends on:** none
**Files modified:** `electron/reviewer.ts`, `tests/reviewer-loop.test.ts`
`onAgentMessage`: after `queue.push`, `if (this.running && msg.kind === 'result') this.pendingInterrupt = true;`

### Phase 3: Main-process incremental scrollback flush
**Depends on:** none
**Files created:** `electron/scrollback-persist.ts`, `tests/scrollback-persist.test.ts`
**Files modified:** `electron/main.ts`
New module `ScrollbackPersist`: debounced (1s) write of the tile's live ring into scrollback files via tmp+rename; skip-unchanged; never write empty; `flushTile(tileId, lines)` immediate (tile exit, before `recorder.drop`). Wire in `makeRuntime`.

### Phase 4: Docs & steering lines
**Depends on:** Phases 1–3
**Files modified:** `electron/reviewer-tools.ts` (descriptions), `electron/reviewer.ts` (system prompt), `electron/reviewer-plugins.ts` (guidance).

### Phase 5: Ship 0.12.6
**Depends on:** Phases 1–4
`tsc -b`, eslint, vitest, build-main, make-installer, sha, install, confirm, version bump 0.12.6, commit, push.

## §5 File-by-File Breakdown

```
electron/reviewer-tools.ts  [MODIFIED]  search_files/read_tile/read_scrollback + descriptions
electron/scrollback-persist.ts  [NEW]   ScrollbackPersist class
electron/main.ts  [MODIFIED]           wire persist into flushTile/tileExit; dispose at teardown
electron/reviewer.ts  [MODIFIED]       onAgentMessage result preemption + system-prompt wording
electron/reviewer-plugins.ts  [MODIFIED]  plugin guidance wording
tests/reviewer-tools.test.ts  [MODIFIED]
tests/reviewer-loop.test.ts   [MODIFIED]
tests/scrollback-persist.test.ts  [NEW]
apps/desktop/package.json  [MODIFIED]   version 0.12.6
```

## §6 Key Code Lines

```ts
// searchFiles single-file gate
let st: Stats;
try { st = await stat(abs); }
catch { return `error: path not found: ${display}`; }
if (st.isFile()) return searchSingleFile(re, abs, display, maxMatches);
if (!st.isDirectory()) return `error: path is not a file or directory: ${display}`;
// ...existing walk...

// resolveTile
function resolveTile(args, ctx) {
  if (typeof args.tileId === 'string' && args.tileId.length > 0) {
    if (ctx.recorder.has(args.tileId)) return args.tileId;
    return ctx.agentOfTile(args.tileId);
  }
  if (typeof args.agentId === 'string' && args.agentId.length > 0) return ctx.tileOfAgent(args.agentId);
  return null;
}

// scrollback-persist.ts
export interface ScrollbackPersistOpts {
  sessionDir: string;
  agentOfTile: (tileId: string) => string | null;
  linesOf: (tileId: string) => string[];
  debounceMs?: number;
  logger?: (line: string) => void;
}
export class ScrollbackPersist {
  note(tileId: string): void;
  flushTile(tileId: string, lines: string[]): Promise<void>;
  dispose(): void;
}

// reviewer.ts result preemption
if (this.running && msg.kind === 'result') this.pendingInterrupt = true;
```

## §7 Risks & Open Questions

- Renderer/main dual writers: both capture the live window; main uses tmp+rename. Low risk.
- Existing tool tests change behavior: intentional, builder updates.
- Setup-window results stay FIFO (pendingInterrupt cleared before loop). Documented.
- Flush I/O bounded by skip-unchanged; ≤1 write/s per active tile.
- Open question (default): exact teardown point for `persist.dispose()` → the session-infra cleanup where `recorder` is released.

## §8 Verification Strategy

- Static: `tsc -b`, `npx eslint`, `npx vitest run`.
- Runtime-only (presented at end): rebuild installer, install 0.12.6, relaunch, confirm version + bundle, live check of read_scrollback freshness and single-file search.
