import { watch, type FSWatcher } from 'node:fs';

const DEBOUNCE_MS = 300;

/** Watches open editor files for out-of-app changes (an agent editing the
 *  file on disk while the editor holds it). One fs.watch handle per path;
 *  change events are debounced per path so a burst of writes yields one
 *  notification. Watchers are non-persistent: they never keep the process
 *  alive. */
export class FileWatchRegistry {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Set<string>();

  constructor(private readonly onChange: (path: string) => void) {}

  watch(path: string): void {
    if (this.watchers.has(path)) return;
    try {
      const watcher = watch(path, { persistent: false }, (event) => {
        // 'rename' covers atomic write-temp+rename (this app's own
        // writeAtomic, vim, most agents) — treating it as a change keeps the
        // stale banner honest; the inode binding is dead after a rename, so
        // the watch is dropped and re-armed by the next watch() call
        if (event === 'rename') {
          this.unwatch(path);
          this.onChange(path);
          return;
        }
        if (event !== 'change') return;
        this.pending.add(path);
        if (this.timers.has(path)) return;
        const timer = setTimeout(() => {
          this.timers.delete(path);
          if (this.pending.has(path)) {
            this.pending.delete(path);
            this.onChange(path);
          }
        }, DEBOUNCE_MS);
        this.timers.set(path, timer);
      });
      watcher.on('error', () => this.unwatch(path));
      this.watchers.set(path, watcher);
    } catch {
      // the file may already be gone — nothing to watch
    }
  }

  unwatch(path: string): void {
    const timer = this.timers.get(path);
    if (timer) clearTimeout(timer);
    this.timers.delete(path);
    this.pending.delete(path);
    const watcher = this.watchers.get(path);
    if (watcher) {
      watcher.close();
      this.watchers.delete(path);
    }
  }
}
