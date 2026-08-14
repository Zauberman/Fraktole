import React, { useCallback, useEffect, useState } from 'react';
import { bridge } from '../ipc.js';
import type { RemoteStatus } from '../shared/ipc.js';

function formatFingerprint(hex: string): string {
  const pairs = hex.toLowerCase().match(/.{1,2}/g) ?? [];
  return pairs.map((p) => p.toUpperCase()).join(':');
}

function timeAgo(ts: number): string {
  if (ts <= 0) return 'never';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * The Remote tab: control surface for the WSS bridge (docs/remote-protocol.md).
 * Shows the enable switch, port, LAN addresses, the cert fingerprint (the
 * TOFU pin a careful user can cross-check), the live pairing code, and the
 * paired devices with revoke buttons.
 */
export function RemoteTab(): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [portInput, setPortInput] = useState('8833');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await bridge.getRemoteStatus());
    } catch {
      // bridge unavailable — the tab stays empty
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsub = bridge.onRemoteStatus(setStatus);
    return unsub;
  }, [refresh]);

  const toggle = useCallback(async (enabled: boolean): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await bridge.setRemoteEnabled(enabled));
    } catch {
      // keep the previous status on failure
    } finally {
      setBusy(false);
    }
  }, []);

  const applyPort = useCallback(async (): Promise<void> => {
    const port = Number(portInput.trim());
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return;
    setBusy(true);
    try {
      setStatus(await bridge.setRemotePort(port));
    } catch {
      // keep the previous status on failure
    } finally {
      setBusy(false);
    }
  }, [portInput]);

  const revoke = useCallback(
    async (deviceId: string): Promise<void> => {
      const device = status?.devices.find((d) => d.deviceId === deviceId);
      if (!device) return;
      if (!window.confirm(`Revoke "${device.name}"? Its token stops working immediately.`)) return;
      await bridge.revokeRemoteDevice(deviceId).catch(() => undefined);
      void refresh();
    },
    [status, refresh],
  );

  const enabled = status?.enabled ?? false;

  return (
    <div className="pane pane-workspace">
      <div className="remote-tab">
        <div className="remote-section">
          <div className="remote-row">
            <label className="remote-switch-label" htmlFor="remote-enable">
              <span className="remote-title">Remote access</span>
              <span className={`remote-hint${enabled && !status?.listening && status?.error ? ' remote-hint-error' : ''}`}>
                {enabled
                  ? status?.listening
                    ? 'listening — phones can pair and connect'
                    : status?.error
                      ? status.error
                      : 'enabled, not listening'
                  : 'off — nothing is exposed'}
              </span>
            </label>
            <button
              id="remote-enable"
              type="button"
              role="switch"
              aria-checked={enabled}
              className={`switch${enabled ? ' switch-on' : ''}`}
              disabled={busy}
              onClick={() => void toggle(!enabled)}
            >
              <span className="switch-knob" />
            </button>
          </div>
        </div>

        {enabled && (
          <>
            <div className="remote-section">
              <div className="remote-row">
                <div>
                  <div className="remote-title">Port</div>
                  <div className="remote-hint">TLS WebSocket endpoint on every interface</div>
                </div>
                <div className="remote-port">
                  <input
                    className="remote-port-input"
                    value={portInput}
                    spellCheck={false}
                    onChange={(e) => setPortInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void applyPort();
                    }}
                  />
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void applyPort()} disabled={busy}>
                    apply
                  </button>
                </div>
              </div>
              <div className="remote-grid">
                <div>
                  <div className="remote-title">Connect from your phone</div>
                  <div className="remote-hint">wss://&lt;ip&gt;:{(status?.port ?? 8833).toString()} — with the pairing code below</div>
                  <ul className="remote-ips">
                    {status?.lanIps.length ? (
                      status.lanIps.map((ip) => <li key={ip}>{ip}</li>)
                    ) : (
                      <li className="remote-faint">no LAN IPs detected</li>
                    )}
                  </ul>
                </div>
                <div>
                  <div className="remote-title">Server certificate fingerprint (TOFU pin)</div>
                  <div className="remote-fingerprint mono">
                    {status?.fingerprint ? formatFingerprint(status.fingerprint) : '—'}
                  </div>
                </div>
              </div>
            </div>

            <div className="remote-section">
              <div className="remote-title">Pairing code</div>
              <div className="remote-hint">
                One-time code — rotates every 5 minutes and dies after the first use
              </div>
              <div className="remote-code mono">{status?.pairingCode ?? '—'}</div>
            </div>

            <div className="remote-section">
              <div className="remote-title">Devices</div>
              {status?.devices.length === 0 ? (
                <div className="remote-faint">no paired devices yet — enter the code on your phone</div>
              ) : (
                <table className="remote-devices">
                  <thead>
                    <tr>
                      <th>device</th>
                      <th>status</th>
                      <th>last seen</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {status?.devices.map((d) => (
                      <tr key={d.deviceId}>
                        <td className="mono">{d.name}</td>
                        <td>
                          <span className={`remote-dot${d.connected ? ' remote-dot-on' : ''}`} />
                          {d.connected ? 'connected' : 'offline'}
                        </td>
                        <td className="mono">{timeAgo(d.lastSeen)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => void revoke(d.deviceId)}
                          >
                            revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
