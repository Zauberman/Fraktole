import { describe, expect, it } from 'vitest';
import { ReviewerTools } from '../electron/reviewer-tools.js';

const defs = new ReviewerTools().definitions();
const byName = new Map(defs.map((d) => [d.name, d]));

describe('tool documentation', () => {
  it('every tool has a substantive description with no emoji', () => {
    for (const d of defs) {
      expect(d.description.length, `${d.name} description too short`).toBeGreaterThanOrEqual(60);
      expect(d.description, `${d.name} description has emoji`).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });

  it('every inputSchema property is documented', () => {
    for (const d of defs) {
      const props = (d.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [key, prop] of Object.entries(props)) {
        expect(prop.description, `${d.name}.${key} missing description`).toBeTruthy();
      }
    }
  });

  it('pairs cross-reference each other (selection guidance)', () => {
    const rt = byName.get('read_tile')!.description;
    const rs = byName.get('read_scrollback')!.description;
    expect(rt).toContain('read_scrollback');
    expect(rs).toContain('read_tile');

    const sp = byName.get('spawn_agent')!.description;
    const la = byName.get('launch_agent')!.description;
    expect(sp).toContain('launch_agent');
    expect(la).toContain('spawn_agent');

    const rf = byName.get('read_file')!.description;
    const ld = byName.get('list_dir')!.description;
    expect(rf).toContain('list_dir');
    expect(rf).toContain('search_files');
    expect(ld).toContain('search_files');
  });

  it('kill_agent documents the direct-kill contract', () => {
    const d = byName.get('kill_agent')!.description;
    expect(d).toContain('Always allowed');
    expect(d).toContain('Never target the orchestrator');
  });
});
