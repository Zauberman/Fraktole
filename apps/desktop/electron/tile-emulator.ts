/** A real terminal emulator per agent tile, driving the scrollback recording.
 *  Feed raw PTY chunks; get back clean, committed lines. Using @xterm/headless
 *  (the same engine family as the renderer) makes full-screen TUIs like
 *  opencode collapse correctly BY CONSTRUCTION: alternate-screen frames never
 *  leak into scrollback, cursor save/restore, scroll regions, wide chars and
 *  erases all behave like the user's real terminal.

 *  Emission model:
 *   • normal buffer — lines that scroll INTO scrollback are emitted exactly
 *     once, in order. At the scrollback cap xterm shifts the buffer (drops
 *     line 0); a content watermark on the newest scrollback line detects the
 *     shift, so capped sessions keep emitting (one missed duplicate-content
 *     line is the only possible loss — cosmetic).
 *   • alternate buffer — the TUI's current frame is emitted as rows whose
 *     text changed since the previous chunk (readable live view; the alt
 *     screen has no scrollback to commit).
 *   • on alt→normal switch the watermarks reset so hidden-then-restored rows
 *     re-emit as they repaint (opencode's exit summary appears, no leftovers). */

import { Terminal } from '@xterm/headless';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const MAX_EMIT_PER_PUSH = 512;

export class TileEmulator {
  private readonly term: Terminal;
  /** Scrollback lines already emitted (count of buffer ybase covered). */
  private emittedYbase = 0;
  /** Content of the newest scrollback line at last emission — the shift
   *  detector once xterm's scrollback cap is reached. */
  private newest: string | null = null;
  /** Last emitted frame snapshot for the alternate screen, row → text. */
  private altSnapshot: Array<string | null> = [];
  private altActive = false;

  private readonly cap: number;

  constructor(
    cols: number = DEFAULT_COLS,
    rows: number = DEFAULT_ROWS,
    maxScrollback: number = 5000,
  ) {
    this.cap = Math.max(rows, maxScrollback);
    this.term = new Terminal({
      cols,
      rows,
      scrollback: this.cap,
      // the buffer API (active/normal/alternate buffers) is marked proposed
      // in xterm 5.x but stable in practice; the recorder depends on it
      allowProposedApi: true,
      // writeSync logs a deprecation warning once per instance; the hot path
      // requires synchronous parsing (see push), so keep the log clean
      logLevel: 'error',
    });
  }

  /** Feed a raw PTY chunk; returns the lines that committed to the recording. */
  push(chunk: string): string[] {
    // writeSync: the normal write() queues through an async write buffer,
    // but the ptyData hot path needs the recording current by the time the
    // reviewer's next read_tile runs. Deprecated in xterm 5.x, present on
    // the core terminal in the pinned @xterm/headless@5.5.0 — revisit when
    // upgrading xterm.
    (this.term as unknown as { _core: { writeSync(data: string): void } })._core.writeSync(chunk);
    const buf = this.term.buffer.active;
    const out: string[] = [];
    if (buf.type !== 'alternate') {
      if (this.altActive) {
        // leaving the alternate screen: skip what is already in scrollback —
        // repainted content commits normally from here on
        this.altActive = false;
        this.altSnapshot = [];
        this.emittedYbase = this.ybase();
        this.newest = this.scrollLine(this.emittedYbase - 1);
      }
      const ybase = this.ybase();
      if (ybase > this.emittedYbase) {
        // no cap here: committed lines are bounded by the chunk itself, and
        // bulk scrolls (cat of a big file, large program dumps) must never
        // silently drop history — the ring downstream bounds memory
        for (let i = this.emittedYbase; i < ybase; i++) {
          out.push(this.scrollLine(i));
        }
        this.emittedYbase = ybase;
        this.newest = this.scrollLine(ybase - 1);
      } else if (ybase === this.cap && ybase > 0) {
        // at capacity: a new scrolled line shifts the buffer, dropping line 0.
        // the newest line changed → one commit (content compare; consecutive
        // identical lines may collapse, which is cosmetic).
        const last = this.scrollLine(ybase - 1);
        if (last !== this.newest) {
          out.push(last);
          this.newest = last;
        }
      }
      return out;
    }
    if (!this.altActive) {
      this.altActive = true;
      this.altSnapshot = [];
    }
    let emitted = 0;
    for (let r = 0; r < this.term.rows && emitted < MAX_EMIT_PER_PUSH; r++) {
      const text = this.rowText(buf, r);
      if (text.length > 0 && text !== this.altSnapshot[r]) {
        out.push(text);
        emitted++;
      }
      this.altSnapshot[r] = text;
    }
    return out;
  }

  /** The visible rows of the active buffer (the on-screen picture): the
   *  normal screen's rows up to the cursor, or the whole alt frame. Leading
   *  and trailing blank rows are dropped; interior blanks are kept. */
  viewportLines(): string[] {
    const buf = this.term.buffer.active;
    let rows: string[];
    if (buf.type === 'alternate') {
      rows = [];
      for (let r = 0; r < this.term.rows; r++) rows.push(this.rowText(buf, r));
    } else {
      rows = [];
      const from = this.ybase();
      const to = from + Math.min(buf.cursorY, this.term.rows - 1);
      for (let i = from; i <= to; i++) rows.push(this.rowText(buf, i));
    }
    while (rows.length > 0 && rows[0]!.length === 0) rows.shift();
    while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
    return rows;
  }




  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0 && (cols !== this.term.cols || rows !== this.term.rows)) {
      this.term.resize(cols, rows);
      this.altSnapshot = [];
    }
  }

  dispose(): void {
    this.term.dispose();
  }

  private ybase(): number {
    return Math.max(0, this.term.buffer.active.length - this.term.rows);
  }

  private scrollLine(index: number): string {
    return this.rowText(this.term.buffer.active, index);
  }

  private rowText(buf: { getLine(i: number): { translateToString(t?: boolean): string } | undefined }, index: number): string {
    return (buf.getLine(index)?.translateToString(true) ?? '').trimEnd();
  }
}
