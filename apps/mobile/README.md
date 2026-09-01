# Fraktole Remote

Android companion client for [Fraktole](https://github.com/Nusoidal/Fraktole): secure remote control of the desktop workstation over local Wi-Fi.

## What it does

| Screen | Role |
|---|---|
| `SplashScreen` | Boot and session-restore check. |
| `ConnectScreen` | Desktop discovery and pairing via a 6-character one-time code. |
| `SessionsScreen` | Lists desktop sessions with live status and tile counts. |
| `TilesScreen` | Grid of live PTY tiles for the selected session. |
| `TileDetailScreen` | Full terminal stream for a single tile. |
| `OrchestratorScreen` | Reviewer dialogue: goal state, tasks, and prompts. |
| `SettingsScreen` | Connection management, token lifecycle, preferences. |

## Architecture

```
lib/
├── core/
│   ├── protocol/    # Wire protocol models (JSON over WSS)
│   ├── security/    # TLS certificate pinning (TOFU), token storage
│   ├── tiles/       # Tile buffer: coalesced PTY chunk assembly
│   └── transport/   # WSS gateway: reconnect, heartbeat, framing
├── screens/         # UI screens (see table above)
└── state/           # AppController: single source of client state
```

## Security model

- Transport is **WebSocket over TLS (WSS)** with a desktop-generated self-signed certificate.
- First connection pins the certificate fingerprint (TOFU); mismatches abort.
- Pairing uses a one-time code; the client then authenticates with a long-lived exchange token.
- Tokens are stored in **Flutter Secure Storage** (Android Keystore-backed).

Wire protocol details: `docs/remote-protocol.md` (private repository).

## Development

```bash
flutter pub get

# Static analysis
flutter analyze

# Unit tests
flutter test

# On-device integration tests (pairing + control)
flutter test integration_test
```

Requirements: Flutter SDK `^3.12.2`, a reachable desktop running Fraktole with the Remote Bridge enabled (`Alt+4`).
