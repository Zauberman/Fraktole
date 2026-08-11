# Fraktole

A coding agent orchestrator for Linux terminals. One daemon drives multiple
coding agents (opencode, Claude Code, plugins) in parallel, each in its own git
worktree, under the direction of a configurable planner LLM. Approval gates
surface to a TUI dashboard, CLI, or phone; live state streams over WebSocket.

## Quickstart

```bash
pnpm install
./scripts/install-cli.sh       # bundles and puts `fraktole` on PATH
fraktole                       # opens the tabbed TUI (daemon auto-starts)
fraktole dispatch "refactor the auth module" --repo /path/to/repo
```

`fraktole` is one command: no args opens the TUI, subcommands run the CLI.
Direct agent runs skip planning; omit `--driver` to let the planner decompose
the goal into parallel subtasks (toggleable in the TUI Settings tab). Non-git
folders work too: agents run in place, no worktree or merge gate.

## Features

- Parallel agents in isolated git worktrees with gated squash merges
- Planner-agnostic decomposition (Anthropic, OpenAI, Ollama)
- Approval gates: merge-to-base, risky plan steps, agent markers
- Live TUI dashboard + CLI + WebSocket API (phone client planned in `mobile/`)
- JSONL event persistence with crash-safe snapshot/restore
- TLS + device pairing for remote access

## Docs

- `docs/SETUP.md` — install, config, TLS, systemd, pairing
- `docs/ARCHITECTURE.md` — processes, event model, task lifecycle, gates
- `docs/SECURITY.md` — threat model and mitigations (agents run with your user)
- `docs/AGENTS.md` — repo conventions for agent sessions
- `mobile/PLAN.md` — native Android app plan

## Packages

| Package | Role |
|---|---|
| `@fraktole/core` | types, event union, state machine, config, protocol |
| `@fraktole/daemon` | engine, persistence, server, drivers, planner, gates, pairing |
| `@fraktole/cli` | `fraktole` command line |
| `@fraktole/tui` | Ink dashboard |
