# Fraktole

A tiling command center for AI agents on Linux: run multiple coding agents
side by side in your own terminals, drive them from an orchestrator panel, and
delegate review to a built-in reviewer model that can watch every agent live.

The desktop app is the only asset in this repository.

## What it is

- **Node layout** — each session is a tiling workspace (split panes, focus,
  zoom, drag-dividers) where every tile is a real PTY running your shell or a
  coding agent.
- **Sessions** — named, project-bound, keep-alive: switch projects and the
  sessions keep running in the background (PTYs stream on, terminal buffers
  keep recording).
- **Orchestrator panel** — a per-session side panel to spawn agents, send them
  tasks, and collect their results through file mailboxes (star topology:
  agents talk to the orchestrator, never to each other).
- **Reviewer harness** — the built-in reviewer is our own model loop
  (OpenAI-compatible, Anthropic, or Ollama), not a borrowed CLI: it observes
  every agent tile through live recordings, delegates work via the mailboxes,
  runs commands in the project, and streams its transcript in the Reviewer tab.
- **Tabs** — File Editor (CodeMirror), Node, Reviewer; Alt+1/2/3 to switch.
- **Session persistence** — arrangement, scrollback, messages and snapshots
  survive restarts; sessions resume with their mailboxes intact.

## Quickstart

```bash
pnpm install
pnpm installer          # builds release/fraktole-install-<version>.sh
bash release/fraktole-install-<version>.sh   # installs to ~/.local
fraktole-desktop        # launch
```

## Development

```bash
pnpm dev                # vite + electron with live reload
pnpm test               # vitest suite
pnpm typecheck
pnpm lint
```

## Repository layout

| Path | Role |
|---|---|
| `apps/desktop/electron/` | main process: PTY host, sessions, mailboxes, reviewer harness |
| `apps/desktop/src/` | renderer: tiling UI, orchestrator panel, reviewer tab, file editor |
| `apps/desktop/tests/` | unit tests (runtime, mailboxes, recorder, providers, harness loop) |
| `apps/desktop/scripts/` | build + installer tooling |
