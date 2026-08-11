import React, { useEffect, useRef } from 'react';
import { Terminal as Xterm, type ITheme } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import { bridge } from '../ipc.js';
import { useXtermPalette } from '../theme-context.js';

export const JUDGE_TILE_ID = 'orchestrator';

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

interface JudgeTerminalProps {
  sessionId: string;
  /** Bumped whenever the judge (re)spawns: refits and re-arms the resize
   *  window — a fresh CLI tolerates the initial fit, so its PTY ends up
   *  sized to whatever the tab currently is. */
  spawnTick?: number;
}

/**
 * The judge's terminal. The PTY is spawned lazily by main when the reviewer
 * tab is visited (the judge runs the configured CLI, not a bare shell);
 * this component connects the xterm to the session's 'orchestrator' PTY
 * channel and mirrors size changes while the CLI is young.
 */
export function JudgeTerminal({ sessionId, spawnTick }: JudgeTerminalProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const palette = useXtermPalette();
  const applyingThemeRef = useRef(false);
  // opencode (and TUIs in general) exit on a resize once their layout has
  // settled; only resizes within the first seconds of the CLI's life are
  // tolerated. After that window the PTY size is frozen — the display still
  // adapts, the judge's viewport does not.
  const resizeUntilRef = useRef(Date.now() + 5_000);
  const fitRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      fontFamily: token('--font-mono'),
      fontSize: 12,
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

    const fitVisible = (): void => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    };
    fitRef.current = fitVisible;
    fitVisible();
    const { cols, rows } = term;
    bridge.ptyResize(sessionId, JUDGE_TILE_ID, cols, rows);

    const unsubscribeData = bridge.onPtyData(sessionId, JUDGE_TILE_ID, (data) => term.write(data));
    // applying options.theme makes xterm emit the palette as OSC sequences
    // through onData — injected into the judge's PTY this would be terminal
    // input for the CLI agent, which can kill it. Suppress while applying.
    const termDisposable = term.onData((data) => {
      if (!applyingThemeRef.current) bridge.ptyWrite(sessionId, JUDGE_TILE_ID, data);
    });
    const resizeDisposable = term.onResize(({ cols: c, rows: r }) => {
      if (Date.now() <= resizeUntilRef.current) bridge.ptyResize(sessionId, JUDGE_TILE_ID, c, r);
    });

    const ro = new ResizeObserver(() => {
      fitVisible();
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      termDisposable.dispose();
      resizeDisposable.dispose();
      unsubscribeData();
      term.dispose();
      termRef.current = null;
    };
  }, [palette]);

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

  // judge (re)spawned: re-arm the resize window and refit, so the fresh CLI
  // gets its PTY sized to the tab while it still tolerates resizes
  useEffect(() => {
    resizeUntilRef.current = Date.now() + 5_000;
    fitRef.current();
  }, [spawnTick]);

  return <div className="judge-term" ref={hostRef} />;
}
