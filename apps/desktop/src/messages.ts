import { useCallback, useEffect, useState } from 'react';
import { bridge } from './ipc.js';
import type { FraktoleMessage, SendMessageArgs } from './ipc.js';

export interface MessagesState {
  messages: FraktoleMessage[];
  send(args: SendMessageArgs): Promise<boolean>;
}

/**
 * The orchestrator panel's message log. Reloaded when the session changes;
 * live messages arrive via the main-process push channel.
 */
export function useMessages(sessionId: string | null): MessagesState {
  const [messages, setMessages] = useState<FraktoleMessage[]>([]);

  useEffect(() => {
    if (sessionId === null) {
      setMessages([]);
      return;
    }
    let live = true;
    void bridge
      .listMessages()
      .then((m) => {
        if (live) setMessages(m);
      })
      .catch(() => undefined);
    const unsub = bridge.onMessageEvent((msg) => {
      setMessages((prev) => [msg, ...prev.filter((m) => m.id !== msg.id)]);
    });
    return () => {
      live = false;
      unsub();
    };
  }, [sessionId]);

  const send = useCallback(async (args: SendMessageArgs): Promise<boolean> => {
    return bridge.sendMessage(args);
  }, []);

  return { messages, send };
}
