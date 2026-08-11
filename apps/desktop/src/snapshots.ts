import { useCallback } from 'react';
import { bridge } from './ipc.js';
import type { SessionSnapshot } from './ipc.js';

export interface SnapshotsState {
  create(sessionId: string, agentId: string, text: string): Promise<SessionSnapshot>;
  get(sessionId: string, id: string): Promise<SessionSnapshot | null>;
}

/** Judge review artifacts: a captured terminal buffer, storable and
 *  attachable to a result message. */
export function useSnapshots(): SnapshotsState {
  const create = useCallback(
    async (sessionId: string, agentId: string, text: string): Promise<SessionSnapshot> => {
      return bridge.createSnapshot(sessionId, { agentId, text });
    },
    [],
  );

  const get = useCallback(async (sessionId: string, id: string): Promise<SessionSnapshot | null> => {
    return bridge.getSnapshot(sessionId, id);
  }, []);

  return { create, get };
}
