# Fraktole — Agent Guide

## Commands

```bash
pnpm -r test          # unit + integration tests (Vitest)
pnpm -r typecheck     # tsc --noEmit, strict, all packages
pnpm -r lint          # ESLint (flat config) + Prettier formatting (pnpm format)
pnpm -r build         # tsc emit per package
```

## Structure

- `packages/core` — types, `EventEnvelope` discriminated union, task state
  machine (`TRANSITIONS`), config schema, protocol constants. Cross-package
  imports use workspace deps; internal relative imports carry `.js` extensions
  (NodeNext) except in `packages/tui` (bundler resolution, extensionless).
- `packages/daemon` — `task-engine.ts` (queue, transitions, gates, subtask
  reconciliation), `event-bus.ts` (pub/sub + replay ring), `persistence.ts`
  (JSONL + snapshot), `server.ts` (REST + WS), `drivers/` (agent CLI adapters,
  `wireProcess` handles spawn failures), `runner.ts` (stream/timeout/markers),
  `planner/` (LLM adapters), `gates.ts` (merge/agent gates), `pairing.ts`,
  `worktrees.ts` (git worktree lifecycle).
- `packages/cli` — `bin/fraktole.js` (tsx shim); commands in `commands.ts`.
- `packages/tui` — full-screen Ink app. `theme.ts` holds all design tokens (oklch-approximated ANSI hex; never pure black/white); `primitives.tsx` paints backgrounds via `Text backgroundColor` segments (ink 5 has no Box backgroundColor) — `Bar`/`Backdrop`/`Badge`/`Divider`; `layout.ts` is the pure dwindle tiling engine (`dwindle(n, area)` returns flat rects + a split tree that maps to nested row/column Boxes); `agent-window.tsx` renders one agent tile; `sidebar.tsx` is the vertical tab menu; `motion.ts`/`transition.tsx` own the choreography (boot reveal, scene fades, status pulses) and honor `FRAKTOLE_REDUCED_MOTION=1`; `ws-client.ts` has backoff + `get since` backfill.

## Rules

- Strict TS everywhere; never loosen a type to make a test pass.
- Every new event kind must be added to `EVENT_KINDS`, `EventPayloads`, and
  the exhaustive `Record<EventKind, ...>` in `packages/core/tests/events.test.ts`.
- The state machine is the contract: status transitions go through
  `engine.transition` (throws on illegal moves). Gated tasks follow
  queued → planning → running → gating → running/merging.
- `PWD` must be set to the real cwd when spawning agent CLIs (opencode trusts
  `env.PWD` over `getcwd()` — see `drivers/opencode.ts`).
- The daemon never touches the user's checkout: worktrees for agents, throwaway
  detached worktrees + `update-ref` for merges.
- Runtime-only behaviors (real agents, TLS against a live cert, TUI keys) are
  listed in the setup docs — unit tests must not depend on them.
