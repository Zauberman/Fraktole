import { WS_PATH, type EventEnvelope } from '@fraktole/core';
import { WebSocket } from 'ws';

export class WsClient {
  onEvent?: (ev: EventEnvelope) => void;
  onStateChange?: (connected: boolean) => void;

  private ws: WebSocket | undefined;
  private lastSeq = -1;
  private retry = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  get endpoint(): string {
    return this.baseUrl;
  }

  get connected(): boolean {
    const ws = this.ws;
    return ws !== undefined && ws.readyState === ws.OPEN;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private open(): void {
    const url = `${this.baseUrl.replace(/^http/, 'ws')}${WS_PATH}`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      this.onStateChange?.(true);
      ws.send(JSON.stringify({ type: 'get', since: this.lastSeq }));
    });
    ws.on('message', (data) => {
      const ev = JSON.parse(String(data)) as EventEnvelope;
      this.lastSeq = Math.max(this.lastSeq, ev.seq);
      this.onEvent?.(ev);
    });
    ws.on('close', () => {
      this.onStateChange?.(false);
      if (!this.closed) this.scheduleReconnect();
    });
    ws.on('error', () => {
      // 'close' always follows an error; reconnect is scheduled there
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(250 * 2 ** this.retry, 30_000);
    this.retry += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) this.open();
    }, delay);
  }
}
