# Fraktole Mobile — Native Android App Plan

Status: planned. The Linux core is built first; this document is the contract the
Android app is built against. Do not change the daemon API without updating this
file.

## 1. Purpose

A native Kotlin Android app that watches and controls the Fraktole daemon from
anywhere (internet-first). It is a thin client over the daemon's HTTP/WS API —
the same API the TUI and CLI use — so the app has no state of its own.

## 2. Target API (the contract)

- Base URL: `https://<host>:<port>` configured by the user (their own domain/VPS
  or port-forwarded home box). TLS mandatory for remote use.
- Realtime: `WebSocket` on `/ws` (authenticated via `Authorization: Bearer`).
  Client messages: `{ "type": "get", "since": <seq> }` for backfill; the server
  pushes every `EventEnvelope` (`{ id, ts, kind, taskId, payload, seq }`).
- REST:
  - `POST /v1/devices/pair { "code": "<one-time-code>" }` (public) →
    `{ device: { id, name, token } }` — the pairing step.
  - `GET /v1/tasks` → `{ tasks: Task[] }`
  - `GET /v1/tasks/:id` → `{ task, log }`
  - `POST /v1/tasks { goal, repoPath, baseBranch?, driver? }` (no driver ⇒
    orchestrator task)
  - `POST /v1/tasks/:id/cancel`
  - `POST /v1/gates/:id/resolve { decision: "approve" | "deny" }`
  - `GET /v1/devices` (auth) — manage devices.
- Event kinds the app must handle: `TaskCreated`, `TaskQueued`, `TaskPlanning`,
  `PlanReady`, `PlanRejected`, `TaskRunning`, `AgentSpawned`, `LogChunk`,
  `AgentExited`, `GateRequested`, `GateResolved`, `TaskDone`, `TaskFailed`,
  `TaskCancelled`, `MergeStarted`, `MergeDone`, `MergeConflict`.

## 3. Screens

| Screen | Content | Source |
|---|---|---|
| Pairing | one-time code entry, "pair" button, save device token | REST pair |
| Overview | task list: status chip, driver, branch, goal, elapsed; running/gate counts | `GET /v1/tasks` + WS |
| Task detail | live log stream (stdout/stderr), status timeline, actions (cancel) | WS `LogChunk` |
| Gate prompt | approve/deny for open gates with reason + diffStat | WS `GateRequested` |

## 4. Architecture

- Kotlin + Jetpack Compose, single-activity.
- `DaemonClient`: OkHttp + WebSocket (or Ktor client) wrapping the contract
  above; typed DTOs mirroring `@fraktole/core` types.
- `PairingStore` (DataStore): device token persisted after pairing.
- Foreground service with a persistent notification ("Fraktole: N tasks
  running") holding the WebSocket while the app is backgrounded; reconnect with
  exponential backoff (mirror `packages/tui/src/ws-client.ts` semantics:
  250ms → 30s cap) and `get since=` backfill on reconnect.
- Gate approval sends `POST /v1/gates/:id/resolve` and disables the button
  until `GateResolved`.

## 5. Security

- TLS pinned to the daemon certificate (user-provided CA or self-signed pinned
  by hash after first connection; never silent-accept in release builds).
- Device token stored in Android Keystore.
- No FCM in v1; the foreground service keeps the WS alive. FCM is a later
  milestone if battery/permanence becomes a problem.
- Cancellation and gate resolution require no extra confirmation beyond the
  screen's buttons (the desktop TUI/CLI have the same trust model).

## 6. Milestones

- M1: pairing flow + overview list + live WS updates.
- M2: task detail with streaming logs; cancel action.
- M3: gate approval UX (with diffStat display).
- M4: foreground service, reconnect/backfill hardening, TLS pinning, release
  build with signatures.

## 7. Acceptance for M1

- Pairing with a code printed by `fraktole pair` works end to end over TLS.
- Task list updates live; state survives app restart via `get since` backfill.
- Backgrounding does not drop the connection for 15+ minutes.
