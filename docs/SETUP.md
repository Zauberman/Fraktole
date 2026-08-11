# Fraktole Setup

Requires: Linux, Node.js >= 22, git, pnpm (via `corepack enable` or
`npm i -g pnpm`), and at least one agent CLI (`opencode` — others optional).

## 1. Install

```bash
pnpm install
pnpm -r build
./scripts/install-cli.sh        # bundles and puts `fraktole` on PATH (~/.local/bin)
```

`fraktole` is one command: no arguments opens the TUI, subcommands run the CLI
(`start`, `dispatch`, `status`, ...). The daemon auto-starts on first use when
it is not running.

## 2. Configure

```bash
fraktole config path          # prints ~/.config/fraktole/config.json
# create the file, e.g.:
cat > ~/.config/fraktole/config.json <<'EOF'
{
  "dataDir": "/home/<you>/.local/share/fraktole",
  "repos": [
    { "path": "/home/<you>/code/my-repo", "defaultBranch": "main" }
  ],
  "planner": { "provider": "ollama", "model": "llama3.1" },
  "server": {
    "host": "127.0.0.1",
    "port": 8756,
    "tokens": ["$(openssl rand -hex 32)"]
  }
}
EOF
```

Planner providers: `anthropic` (default, needs `ANTHROPIC_API_KEY` or
`planner.apiKeyEnv`), `openai`, or `ollama` (local, no key).

## 3. Run

```bash
fraktole start                # daemon (detached, pidfile in dataDir)
fraktole dispatch "refactor the auth module" --repo /path/to/repo
fraktole status               # watch statuses
fraktole-tui                  # dashboard: j/k select, f follow, x cancel, a/d approve gates, q quit
fraktole logs <taskId> --follow
fraktole gates list && fraktole gates approve <gateId>
```

Direct task (no planning): `fraktole dispatch "fix typo" --repo X --driver opencode`.
Orchestrator task (planner decomposes): omit `--driver`.

## 4. TLS (for remote/phone use)

```bash
scripts/selfsigned.sh ./tls 192.168.1.20   # SAN includes your LAN IP
# set "server": { "tls": { "cert": "./tls/cert.pem", "key": "./tls/key.pem" } }
# local CLI/TUI: pass --insecure (self-signed only; never in production)
```

For internet-first access, put the daemon behind your own domain/VPS with a
real certificate and forward the port.

## 5. Systemd

```bash
sudo cp packaging/fraktole.service /etc/systemd/system/
# edit User=<user> in the unit
sudo systemctl daemon-reload
sudo systemctl enable --now fraktole
```

## 6. Pairing a phone

```bash
fraktole pair                 # prints a one-time code (10 min TTL)
# on the phone: POST /v1/devices/pair { "code": "..." } -> device token
fraktole pair revoke <deviceId>
```

## 7. Gate policy (config)

| Key | Default | Meaning |
|---|---|---|
| `gates.mergeToMain` | `true` | require approval before squashing a task branch into the base branch |
| `gates.destructiveCommands` | `true` | reserved for command-level policies |
| `limits.gateTimeoutMs` | `600000` | unattended gates auto-deny after this |
| `limits.defaultTimeoutMs` | `1800000` | per-agent run timeout (SIGTERM → SIGKILL) |
| `limits.maxConcurrent` | `2` | parallel agent slots |
