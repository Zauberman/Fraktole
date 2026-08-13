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

    const rb = byName.get('run_bash')!.description;
    const bg = byName.get('run_background')!.description;
    expect(rb).toContain('run_background');
    expect(bg).toContain('run_bash');
  });

  it('kill_agent documents the grant flow', () => {
    expect(byName.get('kill_agent')!.description).toContain('ask_user');
    expect(byName.get('kill_agent')!.description).toContain('confirm-kill');
  });
});
