# Prompt pickup: preemptive yield at the tool boundary

## §1 Overview

A user prompt sent to the reviewer while it is mid-turn is queued behind the running turn and only picked up when that turn ends — which in auto compose can be up to `MAX_TOOL_ITERATIONS` (25) model+tool iterations, i.e. minutes (reviewer.ts:818, :798). Compaction is NOT the cause: it runs fast at the turn boundary (reviewer.ts:933) and does not gate pickup. The fix makes a typed user prompt yield the current turn at the next tool boundary: the in-flight model call and its tool results are finished (no work lost, context stays API-valid), then the turn stops and the queued prompt is processed next.

## §2 Decisions Locked

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Interrupt mechanism | Yield at tool boundary | Finish the in-flight `complete()` + its tool results, then break the current turn. No work dropped; context stays valid. |
| D2 | Scope | Typed prompts only | `prompt()` (the user prompt box) sets the interrupt. The autonomous loop's own watchdog wakes and agent-result messages keep normal FIFO ordering. |
| D3 | Flag lifecycle | Clear at the start of every turn | A stale flag from an aborted/stopped run can never spuriously break the next turn. |
| D4 | Ordering | Queue is otherwise unchanged | If other messages are already queued ahead of the prompt they precede it; the yield still bounds the long-turn wait. |

## §3 Architecture

- **New field** `pendingInterrupt: boolean` on `ReviewerHost`.
- `prompt(text)` sets it when a turn is in flight (`this.running`).
- `run()` clears it at the start of each turn (after `queue.shift()`) and checks it at the top of the inner loop — if set, `break` before the next `complete()`, so the turn yields after its current iteration's persisted work.

Data flow: user prompt → `prompt()` → `queue.push` + `pendingInterrupt = true` (if running) → current turn's next iteration sees it → break → outer `while` shifts the prompt → prompt turn starts (clears flag) → processed immediately.

## §4 Phased Execution

### Phase 1: Preemptive yield in reviewer.ts
Depends on: none
Files modified:
- `electron/reviewer.ts` (fields, `prompt()`, `run()` inner loop)

Key code (see §6):
- add `private pendingInterrupt = false;` beside `private running`
- in `prompt()`: `if (this.running) this.pendingInterrupt = true;`
- in `run()`: after `const turn = this.queue.shift()!;` → `this.pendingInterrupt = false;`
- in the inner `for` loop, after the existing `if (aborter.signal.aborted) break;` → `if (this.pendingInterrupt) break;`

Acceptance:
- [ ] A prompt queued while a turn is mid-loop yields that turn after the current iteration (1 assistant + its tool results), then the prompt is processed next
- [ ] No orphaned/API-invalid state (the interrupted turn's messages stay persisted)
- [ ] Sequential prompts (each awaited, turn finished) behave exactly as before — no spurious interrupts
- [ ] A stale flag from an aborted run never breaks the next turn (cleared at turn start)

### Phase 2: Tests + verification
Depends on: Phase 1
Files modified:
- `tests/reviewer-loop.test.ts` (new test)
- `scripts/driver-e2e.mjs` (no change expected; re-run)

Acceptance:
- [ ] New unit test proves the yield (see §6) and existing suite (588) still passes
- [ ] `npx tsc -b`, `npx eslint`, DRIVER-E2E OK

## §5 File-by-File Breakdown

- **`electron/reviewer.ts`** [MODIFIED] — `pendingInterrupt` field; set in `prompt()` when running; clear at turn start and check at inner-loop top in `run()`. ~4 lines.
- **`tests/reviewer-loop.test.ts`** [MODIFIED] — one new test (below).
- **`scripts/driver-e2e.mjs`** [UNCHANGED] — re-run to confirm no regression.

## §6 Key Code Lines

### reviewer.ts
```ts
// field (beside `private running = false;`)
private pendingInterrupt = false;

// prompt() — after queue.push(msg):
if (this.running) this.pendingInterrupt = true;

// run(), after `const turn = this.queue.shift()!;` (before the inner loop):
this.pendingInterrupt = false;   // a stale flag from an aborted run must not break this turn

// run(), inner loop, right after `if (aborter.signal.aborted) break;`:
if (this.pendingInterrupt) break; // a queued user prompt yields the turn at the next tool boundary
```

### test (reviewer-loop.test.ts)
```ts
it('yields the current turn to a queued user prompt at the tool boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), `frak-interrupt-${process.pid}-${++hostSeq}`));
  const recorder = recorderWith('line');
  // turn A would do 2 tool iterations before answering if not interrupted
  const { host, provider } = makeHost(
    [
      { text: '', toolCalls: [{ id: 'c1', name: 'read_tile', args: { tileId: 'tile-1' } }] },
      { text: '', toolCalls: [{ id: 'c2', name: 'read_tile', args: { tileId: 'tile-1' } }] },
      { text: 'done', toolCalls: [] },
    ],
    recorder,
    { dir },
  );
  await host.start();
  await host.prompt('work'); // turn A starts (this.running === true synchronously)
  host.prompt('interrupt');  // queued while turn A is in flight → pendingInterrupt
  await settle(60);
  // the interrupt was processed
  expect(host.conversation.some((e) => e.content === 'interrupt')).toBe(true);
  // turn A yielded after ONE iteration: its assistant reply (the c1 tool call)
  // is immediately followed by the 'interrupt' user turn, with no second
  // assistant tool-call from turn A before it
  const idx = host.conversation.findIndex((e) => e.content === 'interrupt');
  const before = host.conversation.slice(0, idx).filter((e) => e.role === 'assistant');
  expect(before).toHaveLength(1);
  expect(host.conversation.slice(0, idx).some((e) => e.toolCallId === 'c1')).toBe(true);
  expect(host.conversation.slice(0, idx).some((e) => e.toolCallId === 'c2')).toBe(false);
});
```
Note: `host.prompt('work')` is awaited but `run()` continues in the background, so `this.running` is true when the next (un-awaited) `prompt('interrupt')` runs — the interrupt lands deterministically before turn A's second `complete()`. The two `read_tile` tool calls need `recorderWith('line')` so the tool executes.

## §7 Risks & Open Questions

| Risk | Likelihood | Mitigation |
|---|---|---|
| Queue has other items (e.g. agent results) ahead of the prompt → they process first | Low | Accepted per D2/D4 (typed-prompts-only scope); the yield still removes the multi-iteration wait. A prompt sent during one of those turns interrupts it too. |
| Interrupt lands on the turn's last iteration (no-op) | Low | Harmless — the turn ends naturally; the flag is cleared at the next turn start. |
| Test timing (settle-based) | Medium | Deterministic by construction (interrupt sent while `this.running` is true, before turn A's second call); matches the suite's existing settle() convention. |

Open questions: none material. Defaults: yield (not abort) per user choice; typed prompts only.

## §8 Verification Strategy

- Static: `npx tsc -b`, `npx eslint`, `npx vitest run` (588 existing + 1 new).
- Driver: `npx kill-port 5173 9223; node scripts/driver-e2e.mjs` → DRIVER-E2E OK.
- Runtime (user): start a busy auto compose run, type a prompt → the reviewer stops its current step and answers within one model-call/batch instead of after the whole turn.
