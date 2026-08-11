import React, { useEffect, useRef } from 'react';
import { Terminal as Xterm, type ITheme } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import { bridge } from '../ipc.js';
import { useXtermPalette } from '../theme-context.js';

interface TerminalProps {
  tileId: string;
  cwd: string;
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * xterm lifecycle: fit into its container, mirror size changes to the PTY,
 * forward keys to the main process and stream data back. One PTY per tile,
 * spawned on mount.
 */
export function Terminal({ tileId, cwd }: TerminalProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const palette = useXtermPalette();

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
    fit.fit();

    const cols = term.cols;
    const rows = term.rows;
    void bridge.ptySpawn({ tileId, cwd, cols, rows });

    // debug hook: lets the CDP smoke read the live terminal buffer
    const terms = (window as unknown as { __fraktTerms?: Map<string, Xterm> }).__fraktTerms ?? new Map();
    (window as unknown as { __fraktTerms: Map<string, Xterm> }).__fraktTerms = terms;
    terms.set(tileId, term);

    const unsubscribeData = bridge.onPtyData(tileId, (data) => term.write(data));

    const termDisposable = term.onData((data) => bridge.ptyWrite(tileId, data));
    const resizeDisposable = term.onResize(({ cols: c, rows: r }) => bridge.ptyResize(tileId, c, r));

    const ro = new ResizeObserver(() => {
      fit.fit();
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
  }, [tileId, cwd]);

  // live theme switch: xterm accepts a new palette via options.theme without
  // remounting the terminal or losing scrollback
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = palette as ITheme;
  }, [palette]);

  return <div className="terminal-host" ref={hostRef} />;
}
