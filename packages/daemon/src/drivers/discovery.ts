import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { available: boolean; at: number }>();

/** true when an executable with this name exists on PATH (cached 30s) */
export async function commandExists(name: string): Promise<boolean> {
  if (name.includes('/')) {
    return fileExecutable(name);
  }
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.available;
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of dirs) {
    if (await fileExecutable(join(dir, name))) {
      cache.set(name, { available: true, at: Date.now() });
      return true;
    }
  }
  cache.set(name, { available: false, at: Date.now() });
  return false;
}

async function fileExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false; // directories carry X_OK but are not commands
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DiscoveredDriver {
  id: string;
  command: string;
  installed: boolean;
}

/**
 * Reports availability for the given (registered) driver entries. The daemon
 * supplies the registry's known drivers; the TUI uses the result to offer
 * only runnable agents and the server uses it for driver fallback.
 */
export async function discoverDrivers(
  entries: Array<{ id: string; command: string }>,
): Promise<DiscoveredDriver[]> {
  const out: DiscoveredDriver[] = [];
  for (const entry of entries) {
    out.push({
      id: entry.id,
      command: entry.command,
      installed: await commandExists(entry.command),
    });
  }
  return out;
}
