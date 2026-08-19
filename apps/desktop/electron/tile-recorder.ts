/** In-memory per-tile terminal recordings: the harness's live view of every
 *  agent. Each PTY chunk is turned into clean scrollback lines by a small TUI
 *  line-discipline collapser (TuiLineCollapser) that simulates in-place
 *  redraws (\r, cursor moves, erases) the way a real terminal would, so a
 *  full-screen TUI like opencode collapses into readable lines instead of
 *  merging overwritten text. Lines are kept in a bounded ring; the on-disk
 *  scrollback files (written by scrollback-persist) mirror this. No writes
 *  happen on the ptyData hot path beyond the in-memory ring. */

// two-byte sequences: charset select (\x1b(0), DECKPAM/DECKPNM (\x1b= >),
// DECALN (\x1b#8), ISO 2022 (\x1b%G) and friends — ignored by the collapser
const TWO_BYTE = new Set(['(', ')', '#', '%', '=', '>']);

// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[- /]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const TWO_BYTE_RE = /\x1b[()#%=>][0-9A-Za-z]?/g;

/** Strips all ANSI/OSC/charset escapes from a string (color and cursor alike).
 *  Kept as a general utility; the recorder itself collapses TUI escapes via
 *  TuiLineCollapser instead of deleting them. */
export function stripAnsi(text: string): string {
  return text.replace(OSC_RE, '').replace(CSI_RE, '').replace(TWO_BYTE_RE, '');
}

/** Maintains a bounded 2D screen + cursor and emits committed scrollback lines
 *  as a PTY stream is fed in. Cursor/erase escapes are acted upon; color (SGR),
 *  OSC and charset escapes are skipped. This is what stops opencode's TUI
 *  redraws from concatenating into garbled lines in the recording. */
export class TuiLineCollapser {
  private rows: string[] = [''];
  private row = 0;
  private col = 0;
  private rowTruncated = false;
  private live = '';

  constructor(private readonly maxCol: number = 4096, private readonly maxRows: number = 240) {}

  /** Feed a raw PTY chunk; returns the lines that committed to scrollback. */
  push(chunk: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < chunk.length) {
      const c = chunk[i]!;
      if (c === '\n') {
        out.push(this.commitRow());
        this.newRowBelow();
        i++;
        continue;
      }
      if (c === '\r') {
        this.col = 0;
        this.rowTruncated = false;
        i++;
        continue;
      }
      if (c === '\b') {
        this.col = Math.max(0, this.col - 1);
        i++;
        continue;
      }
      if (c === '\x1b') {
        i = this.consumeEscape(chunk, i);
        continue;
      }
      this.writeChar(c);
      i++;
    }
    this.live = this.rows[this.row] ?? '';
    return out;
  }

  /** The current on-screen cursor row (the live prompt) — appended to tail/full. */
  liveRow(): string {
    const r = this.live;
    return this.rowTruncated ? `${r}\u2026[truncated]` : r;
  }

  private commitRow(): string {
    const r = (this.rows[this.row] ?? '').replace(/\s+$/, '');
    return this.rowTruncated ? `${r}\u2026[truncated]` : r;
  }

  private newRowBelow(): void {
    if (this.row + 1 < this.rows.length) {
      this.row++;
    } else if (this.rows.length < this.maxRows) {
      this.rows.push('');
      this.row = this.rows.length - 1;
    } else {
      this.rows.shift();
      this.rows.push('');
      this.row = this.maxRows - 1;
    }
    this.col = 0;
    this.rowTruncated = false;
  }

  private writeChar(c: string): void {
    if (this.col >= this.maxCol) {
      this.rowTruncated = true;
      return;
    }
    let s = this.rows[this.row] ?? '';
    if (s.length < this.col) s = s + ' '.repeat(this.col - s.length);
    s = s.slice(0, this.col) + c + s.slice(this.col + 1);
    if (s.length > this.maxCol) s = s.slice(0, this.maxCol);
    this.rows[this.row] = s;
    this.col++;
  }

  private consumeEscape(chunk: string, i: number): number {
    const n = chunk[i + 1];
    if (n === ']') {
      let j = i + 2;
      while (j < chunk.length) {
        if (chunk[j] === '\x07') return j + 1;
        if (chunk[j] === '\x1b' && chunk[j + 1] === '\\') return j + 2;
        j++;
      }
      return j;
    }
    if (n === '[') {
      let j = i + 2;
      while (j < chunk.length && /[0-9;?]/.test(chunk[j]!)) j++;
      const final = chunk[j] ?? '';
      const params = chunk.slice(i + 2, j);
      const nums = params.split(';').map((x) => (x === '' ? 1 : parseInt(x, 10) || 1));
      this.applyCsi(final, nums[0] ?? 1, nums[1] ?? 1);
      return j + 1;
    }
    if (n !== undefined && TWO_BYTE.has(n)) return i + 3;
    return n === undefined ? i + 1 : i + 2;
  }

  private applyCsi(final: string, n: number, m: number): void {
    const k = n <= 0 ? 1 : n;
    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - k);
        break;
      case 'B':
        this.row = Math.min(this.rows.length - 1, this.row + k);
        break;
      case 'C':
        this.col = Math.min(this.maxCol, this.col + k);
        break;
      case 'D':
        this.col = Math.max(0, this.col - k);
        break;
      case 'E':
        this.row = Math.min(this.rows.length - 1, this.row + k);
        this.col = 0;
        break;
      case 'F':
        this.row = Math.max(0, this.row - k);
        this.col = 0;
        break;
      case 'H':
      case 'f':
        this.row = Math.min(this.maxRows - 1, Math.max(0, n - 1));
        this.col = Math.max(0, m - 1);
        this.rowTruncated = false;
        break;
      case 'J':
        this.eraseDisplay(n);
        break;
      case 'K':
        this.eraseLine(n);
        break;
      default:
        break;
    }
  }

  private eraseDisplay(n: number): void {
    if (n === 2 || n === 3) {
      this.rows = this.rows.map(() => '');
      return;
    }
    if (n === 0) {
      this.eraseLine(0);
      for (let r = this.row + 1; r < this.rows.length; r++) this.rows[r] = '';
    } else {
      for (let r = 0; r < this.row; r++) this.rows[r] = '';
      this.eraseLine(1);
    }
  }

  private eraseLine(n: number): void {
    const r = this.rows[this.row] ?? '';
    if (n === 2) {
      this.rows[this.row] = '';
    } else if (n === 1) {
      this.rows[this.row] = ' '.repeat(Math.min(this.col, r.length));
    } else {
      this.rows[this.row] = r.slice(0, this.col);
    }
  }
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
  private readonly collapsers = new Map<string, TuiLineCollapser>();
  private readonly lastAt = new Map<string, number>();

  constructor(opts: TileRecorderOpts = {}) {
    this.maxLines = opts.maxLines ?? 5000;
    this.maxLineLen = opts.maxLineLen ?? 4096;
  }

  /** Feeds one ptyData chunk into the tile's recording. */
  record(tileId: string, chunk: string): void {
    let col = this.collapsers.get(tileId);
    if (!col) {
      col = new TuiLineCollapser(this.maxLineLen);
      this.collapsers.set(tileId, col);
    }
    for (const line of col.push(chunk)) this.append(tileId, line);
    this.lastAt.set(tileId, Date.now());
  }

  has(tileId: string): boolean {
    const bufLen = this.buffers.get(tileId)?.length ?? 0;
    const live = this.collapsers.get(tileId)?.liveRow() ?? '';
    return bufLen > 0 || live.length > 0;
  }

  /** The last `n` lines of the tile, including the in-flight (newline-less)
   *  line — the live prompt is real content the reviewer must see. */
  tail(tileId: string, n: number): string[] {
    const withLive = this.withLive(tileId);
    return withLive.slice(Math.max(0, withLive.length - n));
  }

  /** The ENTIRE recording of the tile (every buffered line plus the
   *  in-flight line) — the full picture for the reviewer, not a tail. */
  full(tileId: string): string[] {
    return this.withLive(tileId);
  }

  /** Lines matching `re` (reset between tests so /g flags are safe). */
  search(tileId: string, re: RegExp, limit = 50): string[] {
    const out: string[] = [];
    for (const line of this.withLive(tileId)) {
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
      const live = this.collapsers.get(tileId)?.liveRow() ?? '';
      if ((this.buffers.get(tileId)?.length ?? 0) > 0 || live.length > 0) {
        out.set(tileId, this.summary(tileId));
      }
    }
    return out;
  }

  /** Releases all state for a tile (its PTY exited or the tile was pruned)
   *  so long-lived sessions do not accumulate per-tile memory forever. */
  drop(tileId: string): void {
    this.buffers.delete(tileId);
    this.collapsers.delete(tileId);
    this.lastAt.delete(tileId);
  }

  private withLive(tileId: string): string[] {
    const lines = this.buffers.get(tileId) ?? [];
    const live = this.collapsers.get(tileId)?.liveRow() ?? '';
    return live.length > 0 ? [...lines, live] : lines;
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
