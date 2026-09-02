import { describe, expect, it } from 'vitest';
import { SHORTCUTS, statusHints } from '../src/shortcuts.js';

describe('status-bar hint strip', () => {
  it('is slim: exactly the three quiet chips', () => {
    expect(statusHints()).toEqual(['ctrl+p files', 'ctrl+shift p commands', 'ctrl+, settings']);
  });

  it('every strip entry comes from a flagged shortcut with keys + noun', () => {
    const flagged = SHORTCUTS.filter((s) => s.strip);
    expect(flagged.length).toBe(3);
    for (const s of flagged) {
      expect(s.hint.length).toBeGreaterThan(0);
      expect(s.noun.length).toBeGreaterThan(0);
    }
  });

  it('shortcut ids are unique', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
