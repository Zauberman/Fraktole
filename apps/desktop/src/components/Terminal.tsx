import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as Xterm, type ITheme } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import { bridge } from '../ipc.js';
import { useXtermPalette } from '../theme-context.js';
import { replayText } from '../scrollback.js';

interface TerminalProps {
  sessionId: string;
  tileId: string;
  cwd: string;
  /** Durable session agent id; provided on restore, omitted on live spawns. */
  agentId?: string | null;
  /** Launcher command written into the shell after spawn. */
  command?: string;
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
export function Terminal({ sessionId, tileId, cwd, agentId, command, onSpawned }: TerminalProps): React.JSX.Element {
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
  const commandRef = useRef(command);
  commandRef.current = command;
  const applyingThemeRef = useRef(false);
  // right-click context menu (copy/paste), positioned in viewport coords
  const [menu, setMenu] = useState<{ x: number; y: number; hasSel: boolean } | null>(null);

  // copy/paste through the native clipboard (main's electron.clipboard):
  // renderer navigator.clipboard.readText is permission-gated, so paste
  // goes over IPC; copy does too for a single reliable path
  const copySelection = useCallback((): void => {
    const term = termRef.current;
    if (!term) return;
    const sel = term.getSelection();
    if (sel) void bridge.clipboardWrite(sel);
  }, []);
  const pasteClipboard = useCallback((): void => {
    const term = termRef.current;
    if (!term) return;
    void bridge
      .clipboardRead()
      .then((text) => {
        if (text) term.paste(text);
      })
      .catch(() => undefined);
  }, []);
  const copyRef = useRef(copySelection);
  copyRef.current = copySelection;
  const pasteRef = useRef(pasteClipboard);
  pasteRef.current = pasteClipboard;

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
      .ptySpawn({
        sessionId,
        tileId,
        cwd,
        cols,
        rows,
        agentId: agentIdRef.current ?? undefined,
        command: commandRef.current,
      })
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
        .getScrollback(sessionId, agentIdRef.current)
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

    const unsubscribeData = bridge.onPtyData(sessionId, tileId, (data) => term.write(data));

    // applying options.theme makes xterm emit the palette as OSC sequences
    // through onData — that would inject terminal input into the PTY (harmless
    // for a shell, fatal for a TUI agent). Suppress forwarding while applying.
    const termDisposable = term.onData((data) => {
      if (!applyingThemeRef.current) bridge.ptyWrite(sessionId, tileId, data);
    });
    const resizeDisposable = term.onResize(({ cols: c, rows: r }) => bridge.ptyResize(sessionId, tileId, c, r));

    // copy/paste: ctrl+shift+c/v (terminal convention — plain ctrl+c stays
    // SIGINT). Returning false keeps the keystroke away from the PTY.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        if (e.code === 'KeyC') {
          copyRef.current();
          return false;
        }
        if (e.code === 'KeyV') {
          pasteRef.current();
          return false;
        }
      }
      return true;
    });

    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, hasSel: term.hasSelection() });
    };
    host.addEventListener('contextmenu', onContextMenu);

    const ro = new ResizeObserver(() => {
      fitVisible();
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      host.removeEventListener('contextmenu', onContextMenu);
      termDisposable.dispose();
      resizeDisposable.dispose();
      unsubscribeData();
      bridge.ptyKill(sessionId, tileId);
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

  return (
    <>
      <div className="terminal-host" ref={hostRef} />
      {menu && (
        <>
          <div
            className="term-menu-backdrop"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="term-menu" style={{ left: menu.x, top: menu.y }}>
            <button
              type="button"
              className="term-menu-item"
              disabled={!menu.hasSel}
              onClick={() => {
                copySelection();
                setMenu(null);
              }}
            >
              copy
            </button>
            <button
              type="button"
              className="term-menu-item"
              onClick={() => {
                void pasteClipboard();
                setMenu(null);
              }}
            >
              paste
            </button>
          </div>
        </>
      )}
    </>
  );
}