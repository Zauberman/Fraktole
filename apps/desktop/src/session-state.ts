import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, type SessionStatus } from './ipc.js';
import { treeFromSer, treeToSer } from './session-tree.js';
import { captureAll } from './scrollback.js';
import type { OpenedSession, SessionSummary } from './ipc.js';
import type { SplitDir, TileId, TileNode } from './window-tree.js';
import { insert, listIds, neighbors, remove, swap } from './window-tree.js';

export interface SessionTileMeta {
  id: TileId;
  cwd: string;
  /** Durable identity within the session; null until the PTY spawn returns. */
  agentId: string | null;
  /** Launcher command written into the shell after spawn (reviewer-spawned
   *  agent tiles; undefined = plain shell). */
  command?: string;
}

interface SessionStateRefs {
  treeRef: React.MutableRefObject<TileNode | null>;
  tilesRef: React.MutableRefObject<Map<TileId, SessionTileMeta>>;
  focusedIdRef: React.MutableRefObject<TileId | null>;
  zoomedIdRef: React.MutableRefObject<TileId | null>;
}

export interface SessionState extends SessionStateRefs {
  sessionId: string;
  session: SessionSummary | null;
  state: SessionStatus;
  tree: TileNode | null;
  tiles: Map<TileId, SessionTileMeta>;
  focusedId: TileId | null;
  zoomedId: TileId | null;
  addTile(cwd: string, agentId?: string | null, command?: string): TileId;
  registerAgent(tileId: TileId, agentId: string): void;
  closeTile(id: TileId, external?: boolean): void;
  moveFocus(dir: 'prev' | 'next'): void;
  onSwap(a: TileId, b: TileId): void;
  setFocusedId(id: TileId): void;
  toggleZoom(id: TileId): void;
  renameSession(name: string): Promise<void>;
  saveSession(opts?: { scrollback?: Record<string, string[]> }): Promise<void>;
  reactivate(): Promise<void>;
  agentOf(tileId: TileId): string | null;
  tileOf(agentId: string): TileId | null;
}

/**
 * One session's workspace state (tree, tiles, focus, zoom) plus its save
 * plumbing. One instance per open session, owned by a SessionView; hidden
 * views stay mounted so their PTYs keep running (keep-alive).
 */
export function useSessionState(sessionId: string): SessionState {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [state, setState] = useState<SessionStatus>('running');
  const [tree, setTree] = useState<TileNode | null>(null);
  const [focusedId, setFocusedId] = useState<TileId | null>(null);
  const [zoomedId, setZoomedId] = useState<TileId | null>(null);
  const [tiles, setTiles] = useState<Map<TileId, SessionTileMeta>>(new Map());

  const nextId = useRef(1);
  const insertDir = useRef<SplitDir>('h');
  const sessionRef = useRef<SessionSummary | null>(null);
  const busyRef = useRef(false);
  const loadedRef = useRef(false);
  // the view emptied because its PTYs were killed externally (stop / crash):
  // saving the empty state would erase the persisted arrangement
  const externalEmptyRef = useRef(false);

  const treeRef = useRef<TileNode | null>(null);
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  const tilesRef = useRef<Map<TileId, SessionTileMeta>>(new Map());
  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);

  const focusedIdRef = useRef<TileId | null>(null);
  useEffect(() => {
    focusedIdRef.current = focusedId;
  }, [focusedId]);

  const zoomedIdRef = useRef<TileId | null>(null);
  useEffect(() => {
    zoomedIdRef.current = zoomedId;
  }, [zoomedId]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const agentOf = useCallback(
    (tileId: TileId): string | null => tilesRef.current.get(tileId)?.agentId ?? null,
    [],
  );

  const tileOf = useCallback(
    (agentId: string): TileId | null =>
      [...tilesRef.current.entries()].find(([, m]) => m.agentId === agentId)?.[0] ?? null,
    [],
  );

  const registerAgent = useCallback((tileId: TileId, agentId: string): void => {
    setTiles((m) => {
      const meta = m.get(tileId);
      if (!meta || meta.agentId === agentId) return m;
      const copy = new Map(m);
      copy.set(tileId, { ...meta, agentId });
      return copy;
    });
  }, []);

  const saveSession = useCallback(
    async (opts?: { scrollback?: Record<string, string[]> }): Promise<void> => {
      const current = sessionRef.current;
      if (!current || busyRef.current) return;
      // never erase a persisted arrangement from an externally-emptied view
      if (tilesRef.current.size === 0 && externalEmptyRef.current) return;
      // a tile whose spawn hasn't resolved yet has no agent id; saving now
      // would either throw in treeToSer or persist a half-built tree
      for (const [, meta] of tilesRef.current) {
        if (meta.agentId === null) return;
      }
      try {
        const ser = treeToSer(treeRef.current, (id) => tilesRef.current.get(id)?.agentId ?? null);
        const focusId = focusedIdRef.current;
        const zoomId = zoomedIdRef.current;
        await bridge.saveSession(sessionId, {
          tree: ser,
          agents: [...tilesRef.current.values()].map((m) => m.agentId as string),
          zoomedAgentId: zoomId ? (tilesRef.current.get(zoomId)?.agentId ?? null) : null,
          focusedAgentId: focusId ? (tilesRef.current.get(focusId)?.agentId ?? null) : null,
          judgeCwd: focusId ? (tilesRef.current.get(focusId)?.cwd ?? null) : null,
          scrollback: opts?.scrollback ?? captureAll((id) => tilesRef.current.get(id)?.agentId ?? null),
        });
      } catch {
        // a save must never take the workspace down
      }
    },
    [],
  );

  const rebuildFrom = useCallback((opened: OpenedSession): void => {
    nextId.current = 1;
    insertDir.current = 'h';
    externalEmptyRef.current = false;
    const idByAgent = new Map<string, TileId>();
    const metas = new Map<TileId, SessionTileMeta>();
    for (const agent of opened.agents) {
      const id = `tile-${nextId.current}`;
      nextId.current += 1;
      idByAgent.set(agent.agentId, id);
      metas.set(id, { id, cwd: agent.cwd, agentId: agent.agentId });
    }
    setTiles(metas);
    setTree(treeFromSer(opened.session.tree, (agentId) => idByAgent.get(agentId) ?? null));
    const focus = opened.session.focusedAgentId ? (idByAgent.get(opened.session.focusedAgentId) ?? null) : null;
    const zoom = opened.session.zoomedAgentId ? (idByAgent.get(opened.session.zoomedAgentId) ?? null) : null;
    setFocusedId(focus);
    setZoomedId(zoom);
  }, []);

  /** Loads this session from main; also called on every (re)activation. */
  const reactivate = useCallback(async (): Promise<void> => {
    busyRef.current = true;
    try {
      let opened = await bridge.openSession(sessionId);
      const wasStopped = opened.state === 'stopped';
      if (wasStopped) {
        // the user switched it off; revive it and respawn its tiles
        await bridge.startSession(sessionId);
        opened = await bridge.openSession(sessionId);
      }
      setState(opened.state);
      setSession({
        id: opened.session.id,
        name: opened.session.name,
        updatedAt: opened.session.updatedAt,
        agentCount: opened.agents.length,
        projectPath: opened.session.projectPath,
      });
      // rebuild only when the view has nothing yet, the session was dead, or
      // the view lost its tiles while the session still has agents (e.g. the
      // user stopped it from another session and started it before switching)
      const viewEmpty = tilesRef.current.size === 0;
      if (!loadedRef.current || wasStopped || (viewEmpty && opened.agents.length > 0)) {
        rebuildFrom(opened);
        loadedRef.current = true;
      }
    } catch {
      // session load failure: leave the view empty; the switcher can retry
    } finally {
      busyRef.current = false;
    }
  }, [sessionId, rebuildFrom]);

  // initial load
  useEffect(() => {
    void reactivate();
  }, [reactivate]);

  const renameSession = useCallback(
    async (name: string): Promise<void> => {
      const current = sessionRef.current;
      if (!current) return;
      try {
        await bridge.saveSessionAs(current.id, name);
        const updated = (await bridge.listSessions()).find((s) => s.id === current.id);
        if (updated) setSession(updated);
      } catch {
        // rename failure is surfaced by the caller through the dialog
      }
    },
    [],
  );

  // debounced auto-save on any structural change
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void saveSession();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [tree, focusedId, zoomedId, tiles, saveSession]);

  // on quit the renderer flushes a final save (with scrollback)
  useEffect(() => {
    const onUnload = (): void => {
      void saveSession();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [saveSession]);

  // periodic safety net: captures scrollback even when nothing structural
  // changes, so a crash loses at most the last 30s
  useEffect(() => {
    const timer = window.setInterval(() => {
      void saveSession();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [saveSession]);

  const addTile = useCallback(
    (cwd: string, agentId: string | null = null, command?: string): TileId => {
      const id = `tile-${nextId.current}`;
      nextId.current += 1;
      const dir = insertDir.current;
      insertDir.current = dir === 'h' ? 'v' : 'h';
      setTiles((m) => {
        const copy = new Map(m);
        copy.set(id, { id, cwd, agentId, command });
        return copy;
      });
      setTree((t) => insert(t, focusedIdRef.current, id, dir));
      setFocusedId(id);
      return id;
    },
    [],
  );

  const closeTile = useCallback((id: TileId, external = false): void => {
    const next = remove(treeRef.current, id);
    setTree(next);
    if (listIds(next).length === 0) externalEmptyRef.current = external;
    if (focusedIdRef.current === id) {
      setFocusedId(listIds(next).length > 0 ? (listIds(next)[0] ?? null) : null);
    }
    if (zoomedIdRef.current === id) setZoomedId(null);
    setTiles((m) => {
      const copy = new Map(m);
      copy.delete(id);
      return copy;
    });
  }, []);

  const moveFocus = useCallback((dir: 'prev' | 'next'): void => {
    setFocusedId((f) => neighbors(treeRef.current, f ?? '', dir));
  }, []);

  const onSwap = useCallback((a: TileId, b: TileId): void => {
    setTree((t) => (t === null ? t : swap(t, a, b)));
  }, []);

  const toggleZoom = useCallback((id: TileId): void => {
    setZoomedId((z) => (z === id ? null : id));
  }, []);

  return {
    sessionId,
    session,
    state,
    tree,
    tiles,
    focusedId,
    zoomedId,
    treeRef,
    tilesRef,
    focusedIdRef,
    zoomedIdRef,
    addTile,
    registerAgent,
    closeTile,
    moveFocus,
    onSwap,
    setFocusedId,
    toggleZoom,
    renameSession,
    saveSession,
    reactivate,
    agentOf,
    tileOf,
  };
}
