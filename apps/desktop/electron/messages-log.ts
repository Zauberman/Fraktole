import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Reads a session's append-only message log (messages.jsonl). Each line is
 *  parsed defensively: a corrupt line is skipped so it can never hide the
 *  rest of the history. Returns the parsed objects in file order. Callers
 *  keep their own mapping and sorting so behavior is byte-identical. */
export async function readMessagesJsonl(sessionRoot: string, sessionId: string): Promise<unknown[]> {
  try {
    const raw = await readFile(join(sessionRoot, sessionId, 'messages.jsonl'), 'utf8');
    const out: unknown[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a corrupt line must not hide the rest of the history
      }
    }
    return out;
  } catch {
    return [];
  }
}
