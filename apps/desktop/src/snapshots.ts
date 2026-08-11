import { useCallback } from 'react';
import { bridge } from './ipc.js';
import type { SessionSnapshot } from './ipc.js';

export interface SnapshotsState {
  create(agentId: string, text: string): Promise<SessionSnapshot>;
  get(id: string): Promise<SessionSnapshot | null>;
}

/** Judge review artifacts: a captured terminal buffer, storable and
 *  attachable to a result message. */
export function useSnapshots(): SnapshotsState {
  const create = useCallback(async (agentId: string, text: string): Promise<SessionSnapshot> => {
    return bridge.createSnapshot({ agentId, text });
  }, []);

  const get = useCallback(async (id: string): Promise<SessionSnapshot | null> => {
    return bridge.getSnapshot(id);
  }, []);

  return { create, get };
}
