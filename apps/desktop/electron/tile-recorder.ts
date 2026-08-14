/** In-memory per-tile terminal recordings: the harness's live view of every
 *  agent. Each PTY chunk is ANSI-stripped and reassembled line by line into
 *  a bounded ring (scrollback beyond the ring stays in the on-disk scrollback
 *  files captured by the renderer). Data lives only in memory — no writes on
 *  the ptyData hot path. */
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[- /]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// two-byte sequences: charset select (\x1b(0), DECKPAM/DECKPNM (\x1b= >),
// DECALN (\x1b#8), ISO 2022 (\x1b%G) and friends
// eslint-disable-next-line no-control-regex
const TWO_BYTE_RE = /\x1b[()#%=>][0-9A-Za-z]?/g;

export function stripAnsi(text: string): string {
  return text.replace(OSC_RE, '').replace(CSI_RE, '').replace(TWO_BYTE_RE, '');
}

export interface TileRecorderOpts {
  /** Ring size per tile. */
  maxLines?: number;
  /** Per-line cap; longer lines are truncated with a marker. */
  maxLineLen?: number;
}

export class TileRecorder {
  private readonly maxLines: number;
  private readonly maxLineLen: number;
  private readonly buffers = new Map<string, string[]>();
  private readonly partial = new Map<string, string>();
  private readonly lastAt = new Map<string, number>();

  constructor(opts: TileRecorderOpts = {}) {
    this.maxLines = opts.maxLines ?? 2000;
    this.maxLineLen = opts.maxLineLen ?? 4096;
  }

  /** Feeds one ptyData chunk into the tile's recording. */
  record(tileId: string, chunk: string): void {
    const clean = stripAnsi(chunk).replace(/\r/g, '');
    if (clean.length === 0) return;
    let buf = this.partial.get(tileId);
    if (buf === undefined) {
      buf = '';
      this.partial.set(tileId, buf);
    }
    const parts = clean.split('\n');
    buf += parts.shift() ?? '';
    for (const p of parts) {
      this.append(tileId, buf);
      buf = p;
    }
    if (buf.length > this.maxLineLen) {
      buf = `${buf.slice(0, this.maxLineLen)}\u2026[truncated]`;
    }
    this.partial.set(tileId, buf);
    this.lastAt.set(tileId, Date.now());
  }

  has(tileId: string): boolean {
    return (this.buffers.get(tileId)?.length ?? 0) > 0 || (this.partial.get(tileId)?.length ?? 0) > 0;
  }

  /** The last `n` lines of the tile, including the in-flight (newline-less)
   *  line — the live prompt is real content the reviewer must see. */
  tail(tileId: string, n: number): string[] {
    const lines = this.buffers.get(tileId) ?? [];
    const live = this.partial.get(tileId);
    const withLive = live && live.length > 0 ? [...lines, live] : lines;
    return withLive.slice(Math.max(0, withLive.length - n));
  }

  /** Lines matching `re` (reset between tests so /g flags are safe). */
  search(tileId: string, re: RegExp, limit = 50): string[] {
    const lines = [...(this.buffers.get(tileId) ?? [])];
    const live = this.partial.get(tileId);
    if (live && live.length > 0) lines.push(live);
    const out: string[] = [];
    for (const line of lines) {
      re.lastIndex = 0;
      if (re.test(line)) {
        out.push(line);
        if (out.length >= limit) break;
      }
    }
    re.lastIndex = 0;
    return out;
  }

  summary(tileId: string): { lines: number; lastAt: number } {
    return {
      lines: this.buffers.get(tileId)?.length ?? 0,
      lastAt: this.lastAt.get(tileId) ?? 0,
    };
  }

  /** Every tile with recorded content, keyed by tileId. */
  list(): Map<string, { lines: number; lastAt: number }> {
    const out = new Map<string, { lines: number; lastAt: number }>();
    for (const [tileId] of this.buffers) {
      const live = this.partial.get(tileId);
      const lines = this.buffers.get(tileId)?.length ?? 0;
      if (lines > 0 || (live && live.length > 0)) out.set(tileId, this.summary(tileId));
    }
    return out;
  }

  /** Releases all state for a tile (its PTY exited or the tile was pruned)
   *  so long-lived sessions do not accumulate per-tile memory forever. */
  drop(tileId: string): void {
    this.buffers.delete(tileId);
    this.partial.delete(tileId);
    this.lastAt.delete(tileId);
  }

  private append(tileId: string, line: string): void {
    let buf = this.buffers.get(tileId);
    if (!buf) {
      buf = [];
      this.buffers.set(tileId, buf);
    }
    if (line.length > this.maxLineLen) {
      line = `${line.slice(0, this.maxLineLen)}\u2026[truncated]`;
    }
    buf.push(line);
    if (buf.length > this.maxLines) {
      buf.splice(0, buf.length - this.maxLines);
    }
  }
}
