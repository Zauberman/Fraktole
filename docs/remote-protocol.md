# Fraktole Remote — Wire Protocol (v1)

Secure remote control of the Fraktole desktop app from the Android client.
Transport is **WebSocket over TLS (WSS)** with JSON messages. Pairing uses a
one-time code; afterwards the phone authenticates with a long-lived token and
pins the desktop's self-signed certificate fingerprint (TOFU).

## 1. Desktop bridge

- Runs inside the Electron **main process** (`apps/desktop/electron/remote/`).
- Binds `0.0.0.0:<port>` (default **8833**) with a self-signed TLS cert.
  Cert/key persisted under the app's `userData/remote/` (self-signed CA-less
  server cert; SHA-256 fingerprint is displayed in the UI).
- Exposes in the renderer a **Remote tab**:
  - enable/disable the bridge (off by default)
  - show listen port, LAN IPs, server cert fingerprint, current pairing code
  - list connected devices + their last-seen time
  - button to revoke a device (invalidates its token)

## 2. Pairing (first connection)

1. User enables the bridge in the desktop app → a **pairing code** appears,
   format `XXXX-XXXX` (5-char groups, A-Z/0-9). Rotates every 5 minutes and
   is invalidated once used.
2. On the phone: enter `host:port` + pairing code, tap Connect.
3. Phone opens a TLS socket to `host:port` **accepting any certificate for
   this first connection**, records the SHA-256 fingerprint of the server
   cert, then sends:
   ```json
   { "type": "pair", "code": "ABCD-EFGH", "deviceName": "Pixel 8" }
   ```
4. Desktop validates the code (constant-time compare, single use, not
   expired). On success it replies:
   ```json
   { "type": "pair-ok", "token": "<64 hex chars>", "deviceId": "<uuid>", "serverFingerprint": "<sha256 hex>" }
   ```
   The token is stored **hashed (SHA-256)** on the desktop; the raw token and
   the server fingerprint are stored in the phone's secure storage
   (`flutter_secure_storage`).
   On failure: `{ "type": "pair-fail", "reason": "invalid-code" | "expired" }`
   then the socket is closed.
5. Phone reconnects over WSS, verifies the presented cert fingerprint equals
   the stored one (**reject otherwise**), and authenticates.

## 3. Authentication (every connection after pairing)

First frame on a WSS connection (server waits up to 5s, closes otherwise):
```json
{ "type": "auth", "token": "<token>" }
```
Desktop verifies `sha256(token)` against its store. Reply:
```json
{ "type": "auth-ok", "serverName": "Fraktole", "version": "0.11.2", "deviceId": "<uuid>" }
```
or `{ "type": "auth-fail", "reason": "bad-token" }` + close. Only one control
connection per device at a time (new connection evicts the old).

## 4. JSON-RPC (client → server), after auth-ok

Request envelope:
```json
{ "id": 1, "method": "<method>", "params": { ... } }
```
Response:
```json
{ "id": 1, "result": { ... } }
{ "id": 1, "error": { "code": -32601, "message": "..." } }
```

| Method | Params | Result |
|---|---|---|
| `sessions.list` | — | `[{ "id", "name", "project", "alive", "tileCount", "updatedAt" }]` |
| `tiles.list` | `{ "sessionId" }` | `[{ "id", "name", "kind", "cwd", "lines", "lastActiveAgoSec" }]` (kind: agent/shell/reviewer) |
| `tile.subscribe` | `{ "sessionId", "tileId" }` | `{ "ok": true }`; then server streams `tile.output` events; also sends one `tile.snapshot` with recent scrollback tail (up to 200 lines) |
| `tile.unsubscribe` | `{ "tileId" }` | `{ "ok": true }` |
| `tile.list` | `{ "sessionId" }` | alias of tiles.list |
| `scrollback.read` | `{ "tileId", "tail"? }` | `{ "data": "<raw pty bytes>" }` |
| `task.send` | `{ "agentId", "kind": "task"\|"note", "body" }` | `{ "ok": true, "messageId" }` (delivered via the desktop's mailbox/orchestrator) |
| `messages.list` | `{ "limit"? }` | `[{ "kind", "from", "to", "body", "ts" }]` (last N from the session mailbox) |
| `agent.spawn` | `{ "cwd"?, "kind"?, "name"? }` | `{ "ok": true, "agentId" }` |
| `health` | — | `{ "ok": true, "ts": <ms> }` |

Unknown method → `-32601`. Malformed JSON → `-32700`. Not authenticated
→ `-32000`.

## 5. Server → client events (after auth-ok)

```json
{ "type": "tile.output",   "params": { "tileId", "data": "<utf8/raw>", "ts": <ms> } }
{ "type": "tile.snapshot", "params": { "tileId", "data": "<recent scrollback tail>" } }
{ "type": "tile.state",    "params": { "tileId", "alive": bool, "lines": int } }
{ "type": "session.state", "params": { "sessionId", "alive": bool } }
{ "type": "message.new",   "params": { "kind", "from", "to", "body", "ts" } }
{ "type": "ping",          "params": { "ts": <ms> } }
```
Server sends `ping` every 15s; phone replies `pong` (same params). Client may
reconnect with backoff on socket close; resubscribes to tiles after
re-auth.

## 6. Security rules

- TLS everywhere; self-signed cert is fine because the phone pins the
  fingerprint after first pairing (TOFU). Show the fingerprint in both UIs so
  a careful user can cross-check.
- Pairing code: 8 chars, uppercase alnum, one-time, 5-min TTL, constant-time
  compare.
- Tokens: 64 hex chars, stored hashed (SHA-256) on desktop, plaintext only on
  the phone (secure storage). Revocable per device.
- Server limits: max 4 concurrent connections; per-connection message rate
  limit (e.g. 120 msg/s); body size ≤ 1 MiB.
- No credentials/logs of token values written to disk on the desktop.

## 7. Testing interop

- Desktop: `pnpm test` (unit tests in `apps/desktop/tests/`) must include the
  new remote module. `pnpm typecheck`, `pnpm lint` clean.
- Phone: `flutter analyze` clean; widget tests under `apps/mobile/test/`;
  `flutter build apk --debug` succeeds.
- A manual smoke path: run desktop `pnpm dev`, enable Remote, then either use
  `node apps/desktop/scripts/remote-smoke.mjs` (a small WSS client that pairs
  + auths + lists sessions) or the phone app against the same port.
