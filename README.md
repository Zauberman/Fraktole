# Fraktole

> **A Linux-native tiling command center for orchestrating autonomous AI coding agents, Allowing UI easiness for Loops , with a set of premaid loops (Auto compose).**

Fraktole pairs real terminal multiplexing with a supervising **Reviewer model** that acts as an autonomous general: it dispatches substantive work to an agent workforce running in live PTY tiles, verifies code and runtime state itself, and manages goals through to completion.

The monorepo contains the desktop workstation (`apps/desktop`) and the Flutter Android remote companion (`apps/mobile`) with its local TLS pairing bridge.

---

## Highlights

```
┌────────────────────────────────────────┬───────────────────────────────────────┐
│              WORKSPACE                 │               REVIEWER                │
│  ┌─────────────────┬─────────────────┐ │  ┌─────────────────────────────────┐  │
│  │ Build Agent 1   │ Build Agent 2   │ │  │ Goal: Implement TLS remote      │  │
│  │ (opencode / pty)│ (opencode / pty)│ │  │ [x] Generate RSA cert           │  │
│  ├─────────────────┴─────────────────┤ │  │ [ ] Wire WSS handshake          │  │
│  │ Fixes Agent / Test Runner         │ │  │                                 │  │
│  │ (shell / vitest)                  │ │  │ Model: claude-3-7-sonnet        │  │
│  └───────────────────────────────────┘ │  │ Context: 42k / 200k (compacted) │  │
│                                        │  └─────────────────────────────────┘  │
└────────────────────────────────────────┴───────────────────────────────────────┘
```

- **Tiling Matrix**: Split-pane workspace of real PTY terminals with drag dividers, keyboard focus cycle, swap, and instant zoom.
- **Delegation Doctrine**: The Reviewer model is pushed to review and orchestrate, rather than edits blindly. It should be able to inspect files, search the codebase, monitor terminal output, and delegates implementation to worker agents.
- **Autonomous Auto Compose**: Dedicated autonomous loops (*Bugs*, *Feature*, *Cyber*, *Frontend*, *Tests*, *Readability*, *Custom*) that operate inside isolated project forks without risking original code.
- **Goal Watchdog & Sub-Goals**: Break large initiatives into tracked sub-goals with self-healing watchdog loops and automated progression upon reaching `GOAL-MET:`.
- **Integrated Browser Testing**: Embedded webview Test tab that the AI can navigate, capture console errors from, screenshot, and verify after fixes.
- **Mobile Remote Companion**: Flutter Android client connecting over end-to-end local TLS/WSS to monitor agents, stream tiles, and review tasks on the go.
- **13 Contrast-Tested Themes**: Built in the `oklch` color space with a curated 4-font typographic design system.

---

## Core Capabilities

### 1. Tiling PTY Matrix & Session Daemon
- **Real Terminals**: Powered by `node-pty` and `@xterm/xterm`, running your preferred shell, CLI harnesses, or autonomous agent tools.
- **Flexible Binary Layout**: Split horizontally or vertically, drag dividers, zoom into any tile with `Ctrl+Shift+Enter`, and switch focus with arrow keys or `Ctrl+Shift+1..9`.
- **Keep-Alive Sessions**: Project-bound sessions run in the background. Switching projects or closing windows never kills active processes, streaming PTYs, or reviewer logs.
- **Session Bundles**: Export and import complete session arrangements, histories, and reviewer states.

### 2. The Reviewer Supervising Harness
The built-in Reviewer is an autonomous control loop supporting **OpenAI-compatible endpoints**, **Anthropic** (Claude 3.5/3.7 with extended thinking), **Ollama** (DeepSeek-R1, Qwen2.5-Coder, Llama), **DeepSeek**, and **Moonshot/Kimi**.

- **Resilient Execution**: Failed tool calls do not abort the turn; the model reads the error and adjusts. Stalled streams (120s timeout) auto-retry.
- **Token-Aware Compaction**: Compaction preserves system prompts, durable task ledgers, and the latest turns while safely trimming older context to ~80% of model limits.
- **Prompt Preemption**: Send prompts while the model is actively working; prompts queue and execute cleanly at turn boundaries.
- **Live Metrics**: Real-time tracking of input tokens, cache-hit tokens, output tokens, and compaction cycles in the footer.

### 3. Auto Compose (Autonomous Loops in Safe Forks)
Auto Compose runs structured, autonomous development loops. Each run launches inside an **isolated project fork** (`.fraktole-auto/`), leaving the master repository untouched:

| Preset | Mission | Loop Workflow |
|---|---|---|
| 🛡️ **Cyber** | Vulnerability hunting | Spawns research counsel to identify injection, auth flaws, secret leakage, and unsafe dependencies; dispatches fixes; verifies before sign-off. |
| 🎨 **Frontend** | Visual & UX polish | Audits layout, responsive behavior, typography, and UX flow; tests live rendered pages in the Test tab. |
| 🐛 **Bugs** | Bug eradication | Discovers crashes, race conditions, edge cases, and unexpected errors; writes reproduction steps and tests. |
| ✨ **Feature** | High-value additions | Finds UX gaps and missing affordances, crafts implementation plans, and dispatches build agents. |
| 🧪 **Tests** | Test suite expansion | Audits test coverage, eliminates flaky tests, and verifies that the suite passes cleanly. |
| 📖 **Readability** | Refactoring & clarity | Reorganizes monolithic files, extracts modules, and cleans dead code while strictly preserving existing behavior. |
| ⚙️ **Custom** | User-defined missions | Execute any custom autonomous prompt sequence. |

---

## The 21 Reviewer Tools

The Reviewer has access to a comprehensive suite of inspection, driving, delegation, and verification tools:

| Category | Tool | Description |
|---|---|---|
| **Tiles & PTY** | `list_tiles` | List active agent tiles, PTY IDs, working directories, line counts, and activity timestamps. |
| | `read_tile` | Read live terminal recordings with `tail`, `grep` regex filtering, or `full` capture. |
| | `read_scrollback` | Inspect up to 5,000 lines of persisted zero-lag terminal scrollback history. |
| | `spawn_agent` | Spawn a new agent tile running a specified command or interactive harness. |
| | `launch_agent` | Write and execute commands inside an existing agent tile terminal. |
| | `kill_agent` | Terminate an agent tile and its child process tree. |
| | `send_keystroke` | Send control keystrokes (`shift-tab`, `enter`, `escape`, `ctrl-c`, arrows) into a tile. |
| | `type_into_tile` | Send raw text and confirmations into interactive agent prompts. |
| **Delegation** | `send_message` | Dispatch structured `task` or informational `note` messages to worker agents. |
| | `list_messages` | Query the session mailbox log for routed tasks, replies, and notifications. |
| **Filesystem** | `read_file` | Read up to 8 project files simultaneously (up to 4 MiB each). |
| | `list_dir` | Tree-walk directories up to 3 levels deep with smart exclusion of build directories. |
| | `search_files` | Search code for patterns or regular expressions with glob filters and line caps. |
| **Test Browser** | `open_test_page` | Open a local or remote URL inside the embedded Test tab webview. |
| | `read_test_page` | Inspect page title, loading state, console logs, and JavaScript errors. |
| | `reload_test_page`| Reload the active test page to verify hot-reload and bug fixes. |
| | `screenshot_test_page` | Capture a PNG screenshot of the webview for user verification. |
| **Ledger & Goals** | `read_state` | Read durable watchdog goals and the task assignment ledger. |
| | `update_task` | Upsert task ledger status (`pending`, `active`, `done`, `failed`). |
| | `set_goal` | Arm, modify, or subdivide top-level watchdog goals into actionable sub-goals. |
| | `ask_user` | Suspend execution and present interactive prompt/confirmation cards to the user. |

---

## Workspace Navigation & Tabs

Fraktole organizes workflow into 4 synchronized views accessible via `Alt+1..4`:

- **File Editor (`Alt+1`)**: Multi-tab code editor powered by CodeMirror 6 with syntax highlighting for TypeScript, JavaScript, Python, HTML, CSS, JSON, and Markdown.
- **Node Matrix & Reviewer (`Alt+2`)**: The central hub displaying the active PTY tile tree alongside the Reviewer dialogue and state ledger.
- **Test Browser (`Alt+3`)**: An embedded webview allowing real-time preview of frontend applications and dev servers.
- **Remote Bridge (`Alt+4`)**: TLS certificate status, active remote connections, and QR/code pairing for the mobile client.

---

## Keyboard Shortcuts

| Shortcut | Context | Action |
|---|---|---|
| `Alt + 1` | Global | Switch to **File Editor** tab |
| `Alt + 2` | Global | Switch to **Node Workspace** tab |
| `Alt + 3` | Global | Switch to **Test Browser** tab |
| `Alt + 4` | Global | Switch to **Remote Bridge** tab |
| `Ctrl + P` | Global | **Quick Open** file fuzzy finder |
| `Ctrl + Shift + T` | Node | Open **New Tile** dialog |
| `Ctrl + Shift + W` | Node | Close the currently focused tile |
| `Ctrl + Shift + Enter` | Node | **Zoom / Unzoom** focused tile |
| `Ctrl + Shift + Arrows` | Node | Cycle focus between adjacent tiles |
| `Ctrl + Shift + 1..9` | Node | Jump focus directly to Tile `1` through `9` |
| `Ctrl + Shift + 0` | Node | Focus the **Reviewer** prompt column |
| `Ctrl + Shift + O` | Node | Open folder / add project to Explorer |

### Reviewer Prompt Commands

Enter these commands directly in the Reviewer input box:
- `/goal <text>` — Arm or update the watchdog goal (bare `/goal` clears it).
- `/compact` — Trigger an immediate context compaction.
- `/summarize` — Generate a session recap and compact older turns.
- `/kill <id>` — Terminate running agent tile `<id>`.

---

## Mobile Remote Client (`apps/mobile`)

The companion Android application connects securely to your desktop workstation over local Wi-Fi:

1. Open the **Remote** tab in Fraktole (`Alt+4`).
2. Launch **Fraktole Remote** on Android and enter the 6-character pairing code.
3. The desktop generates a local self-signed TLS certificate and authenticates the client via an exchange token.
4. Tokens are stored securely in Android Keystore / Flutter Secure Storage for instant reconnection.
5. Monitor live tile outputs, view goal progression, and send commands from your phone.

---

## Quickstart & Installation

### Prerequisites
- **OS**: Linux (x86_64)
- **Node.js**: `>= 22`
- **pnpm**: `>= 10`

### Build Self-Contained Installer
```bash
# Clone repository
git clone https://github.com/Nusoidal/Fraktole.git
cd Fraktole

# Install dependencies
pnpm install

# Build release installer script
pnpm installer

# Run generated installer (installs to ~/.local/bin and desktop entry)
bash apps/desktop/release/fraktole-install-*.sh

# Launch Fraktole
fraktole-desktop
```

### Build Portable AppImage
```bash
pnpm appimage
# The AppImage is generated in apps/desktop/release/
./apps/desktop/release/Fraktole-*.AppImage
```

---

## Development

```bash
# Start Vite renderer + Electron main process with hot reload
pnpm dev

# Run unit and integration tests (Vitest)
pnpm test

# Type-check TypeScript sources
pnpm typecheck

# Lint codebase
pnpm lint

# Run end-to-end mock driver test
node apps/desktop/scripts/driver-e2e.mjs
```

---

## Repository Layout

```
Fraktole/
├── apps/
│   ├── desktop/
│   │   ├── electron/             # Main process: PTY host, Reviewer loop, TLS bridge, sessions
│   │   │   ├── remote/           # TLS certificate generation, WSS pairing, remote store
│   │   │   ├── reviewer/         # Provider adapters (OpenAI, Anthropic, Ollama)
│   │   │   ├── reviewer-tools.ts # 21 Reviewer inspection, driving, and state tools
│   │   │   └── reviewer-plugins.ts # Auto Compose autonomous mission templates
│   │   ├── src/                  # React renderer: tiling tree, CodeMirror editor, themes
│   │   │   ├── components/       # Workspace, Tile, ReviewerTab, TestTab, Explorer, QuickOpen
│   │   │   └── assets/fonts/     # Curated OFL typography (Space Grotesk, JetBrains Mono, etc.)
│   │   ├── scripts/              # Packaging, installer generation, font fetching, E2E driver
│   │   └── tests/                # Test suite for runtime, mailboxes, recorder, and harness
│   └── mobile/                   # Flutter Android remote client
│       ├── lib/                  # Screens, transport gateway, tile buffer, protocol models
│       └── integration_test/     # On-device pairing and control integration tests
├── docs/                         # Protocol specs and interface screenshots
└── package.json                  # Root monorepo workspace manifest
```

---

## License

This project is licensed under the [MIT License](LICENSE).
The bundled fonts in `apps/desktop/src/assets/fonts/` are licensed under the [SIL Open Font License 1.1](http://scripts.sil.org/OFL).
