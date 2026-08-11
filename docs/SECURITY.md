# Fraktole Security Model

## 1. Threat model: no isolation

Agents (opencode, Claude Code, plugins) run as **plain subprocesses with the
daemon user's full permissions**. This is a deliberate choice: agent CLIs need
real shell access to edit files, run builds, and use git. The consequence is
that **any prompt sent to an agent can execute arbitrary code as your user** —
including prompt-injection attacks from repository content the agent reads.

Treat the orchestrator as "the machine can run anything, but it should not do
so silently."

## 2. Mitigations in place

| Control | Where | Effect |
|---|---|---|
| Git worktrees per task | `worktrees.ts` | an agent can only damage its own branch; the base checkout is never its working directory |
| Approval gates | `gates.ts`, engine `requestGate` | merge-to-base, planner-flagged risky steps, and `FRAKTOLE-GATE:` agent markers stop progress until a human approves from TUI/CLI/phone |
| Gate timeout | engine `gateTimeoutMs` | an unattended gate auto-denies after 10 minutes (default) instead of hanging or auto-approving |
| Agent timeouts | `runner.ts` | tasks are killed (SIGTERM → SIGKILL) after `defaultTimeoutMs` (30 min default) |
| Bearer auth | `auth.ts` | REST + WS require a token; no anonymous control |
| Device pairing | `pairing.ts` | phone tokens are one-time-code exchanged, revocable, persisted |
| TLS (optional) | `tls.ts` | transport encryption for internet use; self-signed supported for LAN |
| Ref-only merges | `mergeBack` | squash merges move branch refs without touching your checkout's working tree |

## 3. Known limitations (documented)

- **Bare directories (non-git targets) run agents in place**: no worktree, no
  merge gate. Parallel subtasks are not supported there — decomposition falls
  back to a single agent. Two agents dispatched at the same bare folder edit
  the same files.
- **`FRAKTOLE-GATE` is advisory**: agent CLIs cannot be paused mid-run, so an
  agent marker raises a gate the agent may have already passed. Approve/deny is
  recorded; deny fails the task. The marker is stripped from the log stream.
- **Gated tasks are not sandboxed**: the worktree limits blast radius to the
  branch, but an agent can still read/delete any file the user can, spawn
  processes, and access the network (LLM APIs and registries are reachable).
- **The main checkout lags after merges**: `mergeBack` updates the branch ref
  only; run `git pull`/`git reset --hard main` to refresh the working tree.

## 4. Recommended hardening (optional)

- Run the daemon as a dedicated Linux user whose permissions cover only the
  repos it manages: `useradd -r fraktole` + systemd unit with `User=fraktole`.
- Point `defaultTimeoutMs` and `gateTimeoutMs` down for unattended machines.
- Gate `mergeToMain` stays on unless you accept unattended merges.
- Keep `server.tokens` long (e.g. `openssl rand -hex 32`) and rotate by
  restarting the daemon with a new config.
