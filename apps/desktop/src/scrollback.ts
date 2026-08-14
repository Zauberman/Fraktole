import type { TileId } from './window-tree.js';

/**
 * Terminal scrollback capture + replay. Capture reads every live xterm
 * buffer (via the __fraktTerms debug hook); replay writes persisted lines
 * back into a freshly spawned terminal so a restored session looks like
 * where the user left.
 */

/** The text written to a fresh terminal when a session resumes. */
export function replayText(lines: string[], agentId: string): string {
  if (lines.length === 0) return '';
  const body = lines.join('\r\n');
  return `\r\n\x1b[2m[fraktole] session resume — ${agentId}\x1b[0m\r\n${body}\r\n\x1b[2m[fraktole] live again\x1b[0m\r\n`;
}

/** xterm-compatible minimal shape, so tests can fake the buffer. */
export interface TermLinesLike {
  buffer: {
    active: {
      length: number;
      getLine(index: number): { translateToString(): string } | undefined;
    };
  };
}

/** Captures every line of a terminal's buffer, top to bottom. */
export function captureTerminalLines(term: TermLinesLike): string[] {
  const out: string[] = [];
  const b = term.buffer.active;
  for (let i = 0; i < b.length; i += 1) {
    out.push(b.getLine(i)?.translateToString() ?? '');
  }
  return out;
}

interface TermsMap {
  __fraktTerms?: Map<string, TermLinesLike>;
}

/** Captures every live tile's buffer of one session, keyed by agentId.
 *  The debug map is keyed by `${sessionId}:${tileId}` — tile ids are only
 *  unique per session, so a bare tileId would collide across sessions. */
export function captureAll(sessionId: string, agentOf: (tileId: TileId) => string | null): Record<string, string[]> {
  const terms = (window as unknown as TermsMap).__fraktTerms;
  const out: Record<string, string[]> = {};
  if (!terms) return out;
  const prefix = `${sessionId}:`;
  for (const [key, term] of terms) {
    if (!key.startsWith(prefix)) continue;
    const tileId = key.slice(prefix.length);
    const agentId = agentOf(tileId);
    if (agentId === null) continue;
    out[agentId] = captureTerminalLines(term);
  }
  return out;
}
