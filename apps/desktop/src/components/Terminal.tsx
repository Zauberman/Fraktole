import React, { useEffect, useRef } from 'react';
import { Terminal as Xterm, type ITheme } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import { bridge } from '../ipc.js';
import { useXtermPalette } from '../theme-context.js';
import { replayText } from '../scrollback.js';

interface TerminalProps {
  tileId: string;
  cwd: string;
  /** Durable session agent id; provided on restore, omitted on live spawns. */
  agentId?: string | null;
  /** Reports the agent id assigned by main (live spawns allocate one). */
  onSpawned?(agentId: string): void;
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * xterm lifecycle: fit into its container, mirror size changes to the PTY,
 * forward keys to the main process and stream data back. One PTY per tile,
 * spawned on mount.
 */
export function Terminal({ tileId, cwd, agentId, onSpawned }: TerminalProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const palette = useXtermPalette();
  // callbacks and props must never re-run the mount effect: a re-run would
  // kill and respawn the PTY, and the killed PTY's tile:exit would close the
  // tile. Read them from refs; only tileId/cwd (both stable per tile) mount.
  const onSpawnedRef = useRef(onSpawned);
  onSpawnedRef.current = onSpawned;
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  const applyingThemeRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const fontFamily = token('--font-mono');
    const term = new Xterm({
      fontFamily,
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: palette as ITheme,
      scrollback: 5000,
      allowTransparency: true,
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    // tiles hidden while another is zoomed have no box — fit would compute
    // 0x0; they refit automatically when the ResizeObserver fires on unzoom
    const fitVisible = (): void => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    };
    fitVisible();

    const cols = term.cols;
    const rows = term.rows;
    void bridge
      .ptySpawn({ tileId, cwd, cols, rows, agentId: agentIdRef.current ?? undefined })
      .then((res) => {
        onSpawnedRef.current?.(res.agentId);
      })
      .catch(() => {
        // a spawn failure closes the tile via tile:exit (code -1) in main
      });

    // restored tiles replay their captured buffer so the session looks like
    // where the user left; the live shell continues below the separator
    if (agentIdRef.current !== null && agentIdRef.current !== undefined) {
      void bridge
        .getScrollback(agentIdRef.current)
        .then((lines) => {
          if (!lines || lines.length === 0) return;
          term.write(replayText(lines, agentIdRef.current ?? ''));
        })
        .catch(() => undefined);
    }

    // debug hook: lets the CDP smoke read the live terminal buffer
    const terms = (window as unknown as { __fraktTerms?: Map<string, Xterm> }).__fraktTerms ?? new Map();
    (window as unknown as { __fraktTerms: Map<string, Xterm> }).__fraktTerms = terms;
    terms.set(tileId, term);

    const unsubscribeData = bridge.onPtyData(tileId, (data) => term.write(data));

    // applying options.theme makes xterm emit the palette as OSC sequences
    // through onData — that would inject terminal input into the PTY (harmless
    // for a shell, fatal for a TUI agent). Suppress forwarding while applying.
    const termDisposable = term.onData((data) => {
      if (!applyingThemeRef.current) bridge.ptyWrite(tileId, data);
    });
    const resizeDisposable = term.onResize(({ cols: c, rows: r }) => bridge.ptyResize(tileId, c, r));

    const ro = new ResizeObserver(() => {
      fitVisible();
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      termDisposable.dispose();
      resizeDisposable.dispose();
      unsubscribeData();
      bridge.ptyKill(tileId);
      (window as unknown as { __fraktTerms?: Map<string, Xterm> }).__fraktTerms?.delete(tileId);
      term.dispose();
      termRef.current = null;
    };
    // only tileId/cwd — the durable identity of the PTY — may remount
  }, [tileId, cwd]);

  // live theme switch: xterm accepts a new palette via options.theme without
  // remounting the terminal or losing scrollback. Guard the OSC emission:
  // xterm writes the palette as input sequences, which must not reach the PTY.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    applyingThemeRef.current = true;
    term.options.theme = palette as ITheme;
    const clear = (): void => {
      applyingThemeRef.current = false;
    };
    const timer = window.setTimeout(clear, 60);
    return () => window.clearTimeout(timer);
  }, [palette]);

  return <div className="terminal-host" ref={hostRef} />;
}