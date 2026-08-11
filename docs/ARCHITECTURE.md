# Fraktole Architecture

## Processes

```
┌─────────┐   WS + REST    ┌──────────────────────────┐
│ TUI     │◄──────────────►│  Daemon (packages/daemon)│   spawns subprocesses
│ (Ink)   │                │  ┌────────────────────┐  │   ┌──────────────┐
├─────────┤                │  │ HttpServer (WS+REST)│  │   │ opencode run │
│ CLI     │◄──────────────►│  │ EventBus           │  │──►├──────────────┤
│ (frakto │                │  │ TaskEngine         │  │   │ claude -p    │
│  le)    │                │  │ Planner (LLM)      │  │   └──────────────┘
│ (phone) │                │  │ GateManager        │  │   in git worktrees
│         │                │  │ WorktreeManager    │  │
└─────────┘                │  │ Persistence (JSONL)│  │
                           │  │ Drivers registry   │  │
                           └──────────────────────────┘
```

- The daemon is the single source of truth. TUI, CLI, and phone are stateless
  clients: they subscribe to events and issue commands.
- Control surface: one HTTP server (default `127.0.0.1:8756`) serving REST
  (`/v1/...`) and WebSocket (`/ws`). TLS on the same port when configured.

## Event model

Every state change is an `EventEnvelope` `{ id, ts, kind, taskId, payload,
seq }`. Kinds are a discriminated union in `packages/core/src/events.ts`.
Events are append-only: persisted per task as JSONL, snapshotted every 200
events, replayed on boot. The WebSocket streams live events and honors
`{ type: "get", since }` for backfill.

## Task lifecycle

```
queued → planning → running → gating → running → done
                        │         │ approve (plan-step) → running
                        │         │ approve (merge)     → merging → done
                        │         │ deny / timeout       → failed
                        └─────────┴─ failed / cancelled (terminal)
```

Orchestrator tasks (`POST /v1/tasks` without a driver) go through the planner,
which decomposes them into subtasks (each with its own worktree, linked via
`parentTaskId`). A parent completes only when all subtasks are terminal.

## Gate flow

1. A gate source fires: planner-flagged step, merge-to-base after a task
   completes, or a `FRAKTOLE-GATE:` marker in agent output.
2. The engine halts the task in `gating` (merge gates carry a `diffStat`) and
   publishes `GateRequested`.
3. A human approves or denies from TUI (`a`/`d`), CLI, or phone.
4. Approval resumes the run (plan-step) or runs the squash merge
   (merge); denial or timeout fails the task.

## Key interfaces

- `AgentDriver` / `DriverRegistry` (`drivers/index.ts`): adapter contract for
  agent CLIs; plugins are any CLI accepting a goal as its last argument.
- `TaskHandlers` (`task-engine.ts`): `plan(task)` / `run(task)` — the daemon's
  wiring (`buildDaemon` in `index.ts`) implements them with planner, runners,
  worktrees, and gates.
- `Planner` (`planner/index.ts`): provider-agnostic LLM decomposition with
  strict JSON validation; failures reject the plan and retry once.

## Packages

| Package | Role |
|---|---|
| `@fraktole/core` | types, event union, state machine, config schema, protocol constants |
| `@fraktole/daemon` | engine, persistence, server, drivers, planner, gates, pairing |
| `@fraktole/cli` | `fraktole` command (dispatch/status/logs/gates/cancel/pair/start) |
| `@fraktole/tui` | Ink dashboard (`fraktole-tui`) |
| `mobile/` | Android app plan (`PLAN.md`) |
