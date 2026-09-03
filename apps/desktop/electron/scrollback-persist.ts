import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Debounced durable writer for per-agent scrollback files. The reviewer's
 *  read_scrollback falls back to these files when a tile has no live recording
 *  (app restart, remote/phone view), so they must be kept fresh on the hot
 *  path rather than only at session-save time (which could lag up to 30s).
 *
 *  The in-memory TileRecorder is keyed by tileId; the on-disk files are keyed
 *  by agentId — this module owns that translation via `agentOfTile`. Writes
 *  go through tmp+rename so a crash/torn write can never corrupt a file. */
export interface ScrollbackPersistOpts {
  sessionDir: string;
  /** tileId → agentId ('' or null = not an agent tile; never written). */
  agentOfTile: (tileId: string) => string | null;
  /** Live lines for a tile (e.g. recorder.full(tileId)). */
  linesOf: (tileId: string) => string[];
  /** Debounce between a tile producing output and its file write (ms). */
  debounceMs?: number;
  /** Maximum lines persisted per agent (matches read_scrollback's cap). */
  maxLines?: number;
  logger?: (line: string) => void;
}

export class ScrollbackPersist {
  private readonly debounceMs: number;
  private readonly maxLines: number;
  /** Continuous output used to refresh the debounce forever, starving the
   *  disk write; the pending age is capped so a tile that never goes quiet
   *  still flushes every maxHoldMs. */
  private readonly maxHoldMs: number;
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; since: number }>();
  /** fingerprint (count + last line) of the last write per agentId, used to
   *  skip no-op writes so an idle tile stops hitting disk. */
  private readonly lastWrite = new Map<string, string>();

  constructor(private readonly opts: ScrollbackPersistOpts) {
    this.debounceMs = opts.debounceMs ?? 1_000;
    this.maxHoldMs = (opts.debounceMs ?? 1_000) * 5;
    this.maxLines = opts.maxLines ?? 5_000;
  }

  /** Schedules a debounced write of a tile's live lines. Called on the pty
   *  hot path after a tile produces output. */
  note(tileId: string): void {
    const agentId = this.opts.agentOfTile(tileId);
    if (!agentId) return;
    const pending = this.timers.get(tileId);
    if (pending) {
      // quiet → keep postponing; a nonstop producer must not starve forever
      if (Date.now() - pending.since < this.maxHoldMs) {
        pending.timer.refresh();
        return;
      }
      clearTimeout(pending.timer);
      this.timers.delete(tileId);
    }
    const timer = setTimeout(() => {
      this.timers.delete(tileId);
      void this.writeIfChanged(agentId, this.opts.linesOf(tileId));
    }, pending ? 0 : this.debounceMs);
    timer.unref();
    // a forced flush opens a fresh hold window — the next forced write is
    // another maxHoldMs away, not per-chunk
    this.timers.set(tileId, { timer, since: Date.now() });
  }

  /** Immediate write (tile exit, quit flush, session save) — must be called
   *  while the tile's lines are still available, before the recorder drops
   *  the tile. Cancels any pending debounced write for the tile. Honors the
   *  fingerprint: rewriting byte-identical scrollback is skipped. */
  async flushTile(tileId: string, lines: string[]): Promise<void> {
    const agentId = this.opts.agentOfTile(tileId);
    const pending = this.timers.get(tileId);
    if (pending) {
      clearTimeout(pending.timer);
      this.timers.delete(tileId);
    }
    if (!agentId) return;
    // never create an empty file for a tile that produced nothing
    if (lines.length === 0) return;
    await this.writeIfChanged(agentId, lines);
  }

  /** Cancels all pending timers (session teardown). */
  dispose(): void {
    for (const pending of this.timers.values()) clearTimeout(pending.timer);
    this.timers.clear();
  }

  private async writeIfChanged(agentId: string, lines: string[]): Promise<void> {
    const capped = lines.slice(-this.maxLines);
    if (capped.length === 0) return;
    const fp = this.fingerprint(capped);
    if (this.lastWrite.get(agentId) === fp) return;
    await this.write(agentId, capped);
  }

  private async write(agentId: string, lines: string[]): Promise<void> {
    const dir = join(this.opts.sessionDir, 'scrollback');
    try {
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${agentId}.json`);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      // compact encoding: pretty-printing added ~2x bytes and serialize time
      // on the hottest disk path (readers JSON.parse either way)
      await writeFile(tmp, JSON.stringify({ lines }), 'utf8');
      await rename(tmp, file);
      this.lastWrite.set(agentId, this.fingerprint(lines.slice(-this.maxLines)));
      (this.opts.logger ?? ((): void => undefined))(`scrollback: wrote ${agentId} (${lines.length} lines)`);
    } catch (err) {
      (this.opts.logger ?? ((): void => undefined))(`scrollback: write failed for ${agentId}: ${String(err)}`);
    }
  }

  private fingerprint(lines: string[]): string {
    const last = lines[lines.length - 1] ?? '';
    // middle lines can change while count and last stay equal (in-place
    // rewrites) — sample the middle so those changes are not skipped
    const mid = lines.length > 2 ? lines[Math.floor(lines.length / 2)] ?? '' : '';
    return `${lines.length}\u0000${last.length}\u0000${last}\u0000${mid}`;
  }
}
