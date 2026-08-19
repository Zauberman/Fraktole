import { describe, expect, it } from 'vitest';
import { TileRecorder, stripAnsi } from '../electron/tile-recorder.js';

describe('stripAnsi', () => {
  it('removes CSI sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('a\x1b[2Kb\x1b[Jc')).toBe('abc');
    expect(stripAnsi('x\x1b[?25ly')).toBe('xy');
  });

  it('removes OSC sequences', () => {
    expect(stripAnsi('a\x1b]0;title\x07b')).toBe('ab');
    expect(stripAnsi('a\x1b]633;Pwd=/tmp\x1b\\b')).toBe('ab');
  });

  it('keeps plain text', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
});

describe('TileRecorder', () => {
  it('reassembles lines split across chunks', () => {
    const r = new TileRecorder();
    r.record('t1', 'hel');
    r.record('t1', 'lo\nwor');
    r.record('t1', 'ld\ndone');
    expect(r.tail('t1', 10)).toEqual(['hello', 'world', 'done']);
  });

  it('strips ANSI from chunks and drops carriage returns', () => {
    const r = new TileRecorder();
    r.record('t1', '\x1b[1mstatus:\x1b[0m ok\r\nnext');
    expect(r.tail('t1', 10)).toEqual(['status: ok', 'next']);
  });

  it('evicts beyond maxLines keeping the newest lines (live line included)', () => {
    const r = new TileRecorder({ maxLines: 3 });
    r.record('t1', 'a\nb\nc\nd\ne');
    expect(r.tail('t1', 10)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('truncates over-long lines with a marker', () => {
    const r = new TileRecorder({ maxLineLen: 5 });
    r.record('t1', 'abcdefgh');
    expect(r.tail('t1', 1)[0]).toBe('abcde\u2026[truncated]');
  });

  it('tail returns the last n lines', () => {
    const r = new TileRecorder();
    r.record('t1', 'a\nb\nc\nd\ne');
    expect(r.tail('t1', 2)).toEqual(['d', 'e']);
    expect(r.tail('t1', 99)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('search matches across the ring with a limit and /g-safe regexes', () => {
    const r = new TileRecorder();
    r.record('t1', 'foo\nerror: boom\nbar\nerror: x\nerror: y');
    expect(r.search('t1', /error: (?:boom|x)/)).toEqual(['error: boom', 'error: x']);
    expect(r.search('t1', /error/, 1)).toEqual(['error: boom']);
    const re = /error/g;
    expect(r.search('t1', re)).toHaveLength(3);
    expect(re.lastIndex).toBe(0);
  });

  it('full returns the entire recording including the live line', () => {
    const r = new TileRecorder();
    r.record('t1', 'a\nb\nc\n');
    r.record('t1', 'd\nlive-here');
    expect(r.full('t1')).toEqual(['a', 'b', 'c', 'd', 'live-here']);
    expect(r.tail('t1', 2)).toEqual(['d', 'live-here']);
  });

  it('keeps the newest 5000 lines by default', () => {
    const r = new TileRecorder();
    for (let i = 1; i <= 5100; i += 1) r.record('t1', `line-${i}\n`);
    const all = r.full('t1');
    expect(all.length).toBe(5000);
    expect(all[0]).toBe('line-101');
    expect(all[4999]).toBe('line-5100');
  });

  it('has() is true only after content, summary reports lines', () => {
    const r = new TileRecorder();
    expect(r.has('t1')).toBe(false);
    r.record('t1', 'x\n');
    expect(r.has('t1')).toBe(true);
    expect(r.summary('t1').lines).toBe(1);
    r.record('t2', '');
    expect(r.has('t2')).toBe(false);
  });

  it('separates tiles from each other', () => {
    const r = new TileRecorder();
    r.record('t1', 'one');
    r.record('t2', 'two\nthree');
    expect(r.tail('t1', 1)).toEqual(['one']);
    expect(r.tail('t2', 2)).toEqual(['two', 'three']);
  });
});

describe('TuiLineCollapser (opencode TUI fidelity)', () => {
  it('overwrites in place on \\r instead of merging (real terminal behavior)', () => {
    const r = new TileRecorder();
    // old code produced 'abcdefxy' (merged); a real terminal leaves the tail
    r.record('t1', 'abcdef\rxy\n');
    expect(r.tail('t1', 1)).toEqual(['xycdef']);
  });

  it('repaints a model header cleanly when the line is erased first (ESC[K)', () => {
    const r = new TileRecorder();
    r.record('t1', 'model: sonnet');
    r.record('t1', '\r\x1b[Kmodel: opus\n');
    expect(r.tail('t1', 1)).toEqual(['model: opus']);
    expect(r.full('t1').join('\n')).not.toContain('sonnet');
  });

  it('collapses a \\r progress-bar redraw into the final frame', () => {
    const r = new TileRecorder();
    r.record('t1', '[#.....] 10%\r[#==...] 50%\r[#=====] 100%\n');
    expect(r.tail('t1', 1)).toEqual(['[#=====] 100%']);
  });

  it('handles cursor-up overwrites of a prior line in the live view', () => {
    const r = new TileRecorder();
    r.record('t1', 'line A\nline B\n');
    r.record('t1', '\x1b[ALINEB2');
    // the cursor-up moved up and overwrote "line B" in place (same length)
    expect(r.tail('t1', 1)[0]).toBe('LINEB2');
  });

  it('ESC[2J clears the screen but keeps \\n-scrolled history', () => {
    const r = new TileRecorder();
    r.record('t1', 'hist1\nhist2\n');
    r.record('t1', '\x1b[2Jfresh\n');
    expect(r.full('t1')).toEqual(['hist1', 'hist2', 'fresh']);
  });

  it('still handles agy-style \\r\\n lines (regression)', () => {
    const r = new TileRecorder();
    r.record('t1', 'first\r\nsecond\r\n');
    expect(r.tail('t1', 2)).toEqual(['first', 'second']);
  });

  it('keeps a long unterminated line capped with the truncation marker', () => {
    const r = new TileRecorder({ maxLineLen: 5 });
    r.record('t1', 'abcdefgh');
    expect(r.tail('t1', 1)[0]).toBe('abcde\u2026[truncated]');
  });
});
