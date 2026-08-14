# Fraktole

A tiling command center for AI agents on Linux. Run multiple coding agents side by side in real terminals, drive them from a built-in reviewer model that acts as a general: it delegates substantive work to an agent workforce, verifies the results itself, and reports back with a verdict.

The repository contains the desktop app (`apps/desktop`) and the in-progress Android remote client (`apps/mobile`) with its desktop-side TLS bridge.

## What it is

| Capability | What | How | Effect |
|---|---|---|---|
| Tiling workspace | Every session is a split-pane workspace of real PTY tiles | Drag dividers, focus cycle (arrow keys, `ctrl+shift 1-9`), zoom (`enter`), drag tiles to swap | Run any shell or coding agent side by side |
| Sessions | Named, project-bound, keep-alive | Backgrounded sessions keep their PTYs streaming; arrangements, scrollback, messages and snapshots persist | Switching projects never kills running agents |
| Reviewer harness | The built-in reviewer is our own model loop (OpenAI-compatible, Anthropic, Ollama), not a borrowed CLI | One continuous conversation per session, persisted as JSONL; a goal watchdog loop drives dispatch/verify/re-dispatch until `GOAL-MET:` | A supervising general that works autonomously, not a chat window |
| Delegation doctrine | The reviewer delegates by default and observes by design | Preferred workforce: 3 agent tiles (2 build agents, 1 fixes agent); the reviewer is read-only on the project — `read_file`, `list_dir`, `search_files`, `read_tile` for grasping and verifying; small fixes go to the fixes agent | Agents do the work; the reviewer commands, verifies and judges |
| Goal loop | One armed goal, subdivisible into sub-goals | `/goal <text>` arms the watchdog; the model breaks it into sub-goals via `set_goal (subGoals)`, works through them, and the harness marks every sub-goal done on `GOAL-MET:` | A big goal becomes a managed plan with visible progress |
| Tabs | File Editor, Node, Test | `alt+1/2/3` to switch; the Node tab holds the workspace plus the reviewer column | Code, agents and the test page each get their own view |
| Test tab | An embedded mini browser (webview) | The reviewer opens URLs with `open_test_page`, reads console errors with `read_test_page`, reloads after fixes | Webapp results are verified without leaving the app |
| Theming | 13 oklch themes, contrast-tested | Switch from the native app menu; Sable is the default | Coherent, accessible color system |

## Reviewer loop

The reviewer runs one exclusive loop per session. Everything flows through the same transcript:

1. A turn starts from a user prompt, an agent result, or a watchdog wake.
2. The model calls tools until it stops requesting them (25 iterations max).
3. Each tool result lands in context; a failed tool does not end the turn — the model reads the error and decides.
4. The turn ends with the model's verdict, then the loop picks up the next queued item.

| Property | Behavior |
|---|---|
| Prompting while working | Prompts queue and appear in the transcript immediately; they are processed when the current turn ends |
| Resilience | Any provider failure is retried once, then surfaced; the watchdog revives the harness itself when a goal is armed; a stalled stream (no output for 120s) aborts and retries |
| Compaction | Token-aware, turn-boundary safe: whole turns only, ~80% of the per-model context budget, never drops the two newest turns; compaction auto-wakes the goal loop |
| Usage | Live input / cache-hit / output token counters in the reviewer footer, persisted across restarts |
| Tools | 21 tools: tiles (`list_tiles`, `read_tile`, `read_scrollback`, `spawn_agent`, `launch_agent`, `kill_agent`), delegation (`send_message`, mailbox), files (`read_file` multi-path, `list_dir`, `search_files`), test page, driving (`send_keystroke`, `type_into_tile`), ledger (`read_state`, `update_task`, `set_goal`, `ask_user`) |

## Quickstart

```bash
pnpm install
pnpm installer          # builds release/fraktole-install-<version>.sh
bash release/fraktole-install-<version>.sh   # installs to ~/.local
fraktole-desktop        # launch

# or build a portable AppImage:
pnpm appimage           # builds release/Fraktole-<version>-x86_64.AppImage
chmod +x release/Fraktole-<version>-x86_64.AppImage && ./release/Fraktole-<version>-x86_64.AppImage
```

## Development

```bash
pnpm dev                # vite + electron with live reload
pnpm test               # vitest suite
pnpm typecheck
pnpm lint
node scripts/driver-e2e.mjs   # E2E: mock provider, theme walk, reviewer flows
```

## Repository layout

| Path | Role |
|---|---|
| `apps/desktop/electron/` | main process: PTY host, sessions, mailbox router, reviewer harness, remote TLS bridge |
| `apps/desktop/electron/reviewer/` | provider adapters (openai-compatible, anthropic, ollama) |
| `apps/desktop/src/` | renderer: tiling UI, reviewer column, file editor, test tab, themes |
| `apps/desktop/tests/` | unit tests (runtime, mailboxes, recorder, providers, harness loop, themes, remote bridge) |
| `apps/desktop/scripts/` | build + installer tooling, E2E driver |
| `apps/mobile/` | Flutter Android remote client (in progress) |
| `docs/remote-protocol.md` | WSS pairing/auth/RPC protocol between the desktop bridge and the phone |
