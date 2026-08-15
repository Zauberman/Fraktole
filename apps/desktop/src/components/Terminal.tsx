import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as Xterm, type ITheme } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
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
 * Removes OSC/DCS escape sequences (`ESC ]`, `ESC P`, `ESC _`, `ESC ^`) from
 * a data chunk, keeping everything else. Used while a theme applies: xterm
 * emits its palette as OSC sequences through onData, which must never reach
 * the PTY — but genuine keystrokes typed in that window must still pass.
 * Returns the stripped output plus any dangling (unterminated) remainder,
 * which the caller feeds into the next chunk.
 */
function stripOsc(data: string): { out: string; rest: string } {
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    if (data.charCodeAt(i) === 0x1b && i + 1 < data.length) {
      const seq = data.charCodeAt(i + 1);
      if (seq === 0x5d || seq === 0x50 || seq === 0x5f || seq === 0x5e) {
        // find the terminator: BEL (0x07) or ST (ESC \)
        let j = i + 2;
        let found = false;
        while (j < data.length) {
          if (data.charCodeAt(j) === 0x07) {
            j += 1;
            found = true;
            break;
          }
          if (data.charCodeAt(j) === 0x1b && j + 1 < data.length && data.charCodeAt(j + 1) === 0x5c) {
            j += 2;
            found = true;
            break;
          }
          j += 1;
        }
        if (!found) {
          // unterminated so far — keep it for the next chunk
          return { out: out.join(''), rest: data.slice(i) };
        }
        i = j;
        continue;
      }
    }
    out.push(data.charAt(i));
    i += 1;
  }
  return { out: out.join(''), rest: '' };
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
  const pendingThemeInput = useRef('');
  // right-click context menu (copy/paste), positioned in viewport coords
  const [menu, setMenu] = useState<{ x: number; y: number; hasSel: boolean } | null>(null);
  // scrollback search overlay (Ctrl+Shift+F): open flag, query, and the
  // current/total result counters fed by the SearchAddon's change event
  const [search, setSearch] = useState<{ open: boolean; query: string; index: number; count: number }>({
    open: false,
    query: '',
    index: 0,
    count: 0,
  });
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // live counters are read by the key handler via a ref so the mount effect
  // never needs to re-run
  const searchRef = useRef(search);
  searchRef.current = search;
  const setSearchState = useCallback((patch: Partial<{ open: boolean; query: string; index: number; count: number }>): void => {
    setSearch((prev) => {
      const next = { ...prev, ...patch };
      return next;
    });
  }, []);

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
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    searchAddon.onDidChangeResults((ev) => {
      setSearchState({ index: ev.resultIndex, count: ev.resultCount });
    });
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

    // debug hook: lets the CDP smoke read the live terminal buffer. Keyed by
    // session+tile: tile ids repeat across sessions, a bare tileId would
    // collide (one session's capture would read another session's buffer)
    const termKey = `${sessionId}:${tileId}`;
    const terms = (window as unknown as { __fraktTerms?: Map<string, Xterm> }).__fraktTerms ?? new Map();
    (window as unknown as { __fraktTerms: Map<string, Xterm> }).__fraktTerms = terms;
    terms.set(termKey, term);

    const unsubscribeData = bridge.onPtyData(sessionId, tileId, (data) => term.write(data));

    // applying options.theme makes xterm emit the palette as OSC sequences
    // through onData — that would inject terminal input into the PTY (harmless
    // for a shell, fatal for a TUI agent). While applying, strip only those
    // sequences; real keystrokes still pass through.
    const termDisposable = term.onData((data) => {
      if (!applyingThemeRef.current) {
        bridge.ptyWrite(sessionId, tileId, data);
        return;
      }
      const { out, rest } = stripOsc(pendingThemeInput.current + data);
      pendingThemeInput.current = rest;
      if (out.length > 0) bridge.ptyWrite(sessionId, tileId, out);
    });
    const resizeDisposable = term.onResize(({ cols: c, rows: r }) => bridge.ptyResize(sessionId, tileId, c, r));

    // copy/paste: ctrl+shift+c/v (terminal convention — plain ctrl+c stays
    // SIGINT). Returning false keeps the keystroke away from the PTY.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        if (e.code === 'KeyF') {
          // open the search overlay (Ctrl+Shift+F, terminal convention)
          setSearchState({ open: true });
          return false;
        }
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
      (window as unknown as { __fraktTerms?: Map<string, Xterm> }).__fraktTerms?.delete(`${sessionId}:${tileId}`);
      term.dispose();
      termRef.current = null;
      searchAddonRef.current = null;
    };
    // only tileId/cwd — the durable identity of the PTY — may remount
  }, [tileId, cwd]);

  // live theme switch: xterm accepts a new palette via options.theme without
  // remounting the terminal or losing scrollback. While it applies, onData
  // carries OSC palette emission — stripped by the forwarding guard above.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    applyingThemeRef.current = true;
    term.options.theme = palette as ITheme;
    const clear = (): void => {
      applyingThemeRef.current = false;
      pendingThemeInput.current = '';
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
      {search.open && (
        <div
          className="term-search"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setSearchState({ open: false });
              termRef.current?.focus();
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              const addon = searchAddonRef.current;
              const query = searchRef.current.query;
              if (!addon || query.length === 0) return;
              if (e.shiftKey) addon.findPrevious(query);
              else addon.findNext(query);
              return;
            }
            e.stopPropagation();
          }}
        >
          <input
            ref={searchInputRef}
            className="term-search-input"
            value={search.query}
            placeholder="find in scrollback"
            spellCheck={false}
            autoFocus
            onChange={(e) => {
              const query = e.target.value;
              setSearchState({ query });
              const addon = searchAddonRef.current;
              if (addon) {
                if (query.length === 0) addon.clearDecorations();
                else addon.findNext(query);
              }
            }}
            onBlur={() => searchAddonRef.current?.clearActiveDecoration()}
          />
          <span className="term-search-count">
            {search.query.length === 0 || search.count === 0 ? '0/0' : `${search.index + 1}/${search.count}`}
          </span>
          <button
            type="button"
            className="term-search-btn"
            disabled={search.query.length === 0 || search.count === 0}
            onClick={() => {
              const addon = searchAddonRef.current;
              if (addon && search.query.length > 0) addon.findPrevious(search.query);
            }}
            title="previous (Shift+Enter)"
          >
            prev
          </button>
          <button
            type="button"
            className="term-search-btn"
            disabled={search.query.length === 0 || search.count === 0}
            onClick={() => {
              const addon = searchAddonRef.current;
              if (addon && search.query.length > 0) addon.findNext(search.query);
            }}
            title="next (Enter)"
          >
            next
          </button>
          <button
            type="button"
            className="term-search-btn"
            onClick={() => {
              setSearchState({ open: false });
              termRef.current?.focus();
            }}
            title="close (Esc)"
          >
            close
          </button>
        </div>
      )}
    </>
  );
}