/** The desktop-side view of the world the remote bridge exposes, exactly as
 *  the wire protocol (docs/remote-protocol.md §4) describes it. main.ts
 *  implements this against the live session registry / mailbox router. */

export interface SessionRow {
  id: string;
  name: string;
  /** Bound project path ('' when the session has none). */
  project: string;
  alive: boolean;
  tileCount: number;
  updatedAt: number;
}

export interface TileRow {
  /** Durable agent id (the id used by task.send / tile.subscribe). */
  id: string;
  name: string;
  kind: 'agent' | 'shell' | 'reviewer';
  cwd: string;
  lines: number;
  lastActiveAgoSec: number;
}

export interface MessageRow {
  kind: 'task' | 'result' | 'note';
  from: string;
  to: string;
  body: string;
  ts: number;
}

/** Events the desktop pushes into the bridge (§5). `sessionId` scopes the
 *  fan-out internally; it is not part of the wire params for tile events. */
export type RemoteEvent =
  | { type: 'tile.output'; sessionId: string; tileId: string; data: string; ts: number }
  | { type: 'tile.state'; sessionId: string; tileId: string; alive: boolean; lines: number }
  | { type: 'session.state'; sessionId: string; alive: boolean }
  | { type: 'message.new'; sessionId: string; msg: MessageRow };

export interface RemoteBackend {
  serverName: string;
  version: string;
  listSessions(): Promise<SessionRow[]>;
  listTiles(sessionId: string): Promise<TileRow[]>;
  /** Raw scrollback bytes for a client-facing tile id ('' = none). */
  readScrollback(tileId: string, tail?: number, sessionId?: string): Promise<string>;
  /** Resolves a client-facing tile id to its live tile id (null = not live). */
  liveTileOf(sessionId: string, tileId: string): Promise<string | null>;
  /** Scrollback snapshot for a subscription (≤ 200 lines). */
  snapshot(tileId: string, sessionId?: string): Promise<string>;
  /** Delivers a task/note from the phone into the orchestrator mailbox. */
  sendTask(args: { agentId: string; kind: 'task' | 'note'; body: string }): Promise<{
    ok: boolean;
    messageId?: string;
    error?: string;
  }>;
  /** Last N messages of the session mailbox. */
  listMessages(limit?: number): Promise<MessageRow[]>;
  /** Spawns an agent tile (kind: launcher command; 'shell' = plain shell). */
  spawnAgent(args: { cwd?: string; kind?: string; name?: string }): Promise<{
    ok: boolean;
    agentId?: string;
    error?: string;
  }>;
}
