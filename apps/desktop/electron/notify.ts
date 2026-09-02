import { Notification, type BrowserWindow } from 'electron';
import { IPC } from '../src/shared/ipc.js';

/** Native desktop notifications for reviewer events. Skips silently when
 *  notifications are disabled, when the window exists and is focused (the
 *  user is already looking at the app), or when the same session was
 *  notified within the last 30s. Never throws — a notification failure must
 *  stay invisible. */

export interface NotifyDeps {
  getWindow: () => BrowserWindow | null;
  isEnabled: () => Promise<boolean>;
}

const DEDUPE_MS = 30_000;
const DEDUPE_MAX = 64;

let deps: NotifyDeps | null = null;
const lastShownAt = new Map<string, number>();

/** Wires the module to the app: the window getter and the settings check. */
export function initNotify(d: NotifyDeps): void {
  deps = d;
}

export async function notifyReviewer(opts: { sessionId: string; title: string; body: string }): Promise<void> {
  try {
    const d = deps;
    if (!d || !(await d.isEnabled())) return;
    const win = d.getWindow();
    if (win && win.isFocused()) return;
    const now = Date.now();
    const prev = lastShownAt.get(opts.sessionId);
    if (prev !== undefined && now - prev < DEDUPE_MS) return;
    if (lastShownAt.size >= DEDUPE_MAX) {
      for (const [id, at] of lastShownAt) {
        if (now - at >= DEDUPE_MS) lastShownAt.delete(id);
      }
    }
    lastShownAt.set(opts.sessionId, now);
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: opts.title, body: opts.body });
    note.on('click', () => {
      try {
        const w = d.getWindow();
        if (w) {
          if (w.isMinimized()) w.restore();
          w.show();
          w.focus();
        }
        w?.webContents.send(IPC.menuSession, { action: 'open', id: opts.sessionId });
      } catch {
        // click handling must never surface either
      }
    });
    note.show();
  } catch {
    // a notification failure must be invisible
  }
}
