import { describe, expect, it } from 'vitest';
import { captureTerminalLines, replayText } from '../src/scrollback.js';
import type { TermLinesLike } from '../src/scrollback.js';

function fakeTerm(lines: string[]): TermLinesLike {
  return {
    buffer: {
      active: {
        length: lines.length,
        getLine: (i) => ({ translateToString: () => lines[i] ?? '' }),
      },
    },
  };
}

describe('replayText', () => {
  it('renders the resume banner, lines and live-again marker', () => {
    const out = replayText(['line1', 'line2'], 'agent-3');
    expect(out).toContain('[fraktole] session resume');
    expect(out).toContain('agent-3');
    expect(out).toContain('line1\r\nline2');
    expect(out).toContain('live again');
  });

  it('is empty for no lines', () => {
    expect(replayText([], 'agent-1')).toBe('');
  });
});

describe('captureTerminalLines', () => {
  it('captures every buffer line top to bottom', () => {
    expect(captureTerminalLines(fakeTerm(['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty buffer', () => {
    expect(captureTerminalLines(fakeTerm([]))).toEqual([]);
  });
});
