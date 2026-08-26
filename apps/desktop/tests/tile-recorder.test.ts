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
  // PTYs emit \r\n for every new line — the tests feed exactly that. The
  // recording now runs through a real terminal emulator (@xterm/headless),
  // where a bare \n is a linefeed that KEEPS the cursor column (real
  // terminal behavior), so synthetic bare-\n inputs would carry stray
  // leading spaces into the recorded lines.

  it('reassembles lines split across chunks', () => {
    const r = new TileRecorder();
    r.record('t1', 'hel');
    r.record('t1', 'lo\r\nwor');
    r.record('t1', 'ld\r\ndone');
    expect(r.tail('t1', 10)).toEqual(['hello', 'world', 'done']);
  });

  it('strips ANSI from chunks and drops carriage returns', () => {
    const r = new TileRecorder();
    r.record('t1', '\x1b[1mstatus:\x1b[0m ok\r\nnext');
    expect(r.tail('t1', 10)).toEqual(['status: ok', 'next']);
  });

  it('evicts beyond maxLines keeping the newest committed lines (viewport always visible)', () => {
    const r = new TileRecorder({ maxLines: 3 });
    for (let i = 1; i <= 50; i += 1) r.record('t1', `l${i}\r\n`);
    // 50 lines on a 40-row screen: l40 already scrolls l1 out, so 11 lines
    // commit (l1-l11); the ring keeps the newest 3 (l9-l11); the viewport
    // holds the rest (l12-l50)
    const full = r.full('t1');
    expect(full.length).toBe(42);
    expect(full[0]).toBe('l9');
    expect(full[41]).toBe('l50');
    expect(r.tail('t1', 3)).toEqual(['l48', 'l49', 'l50']);
  });

  it('truncates over-long lines with a marker', () => {
    const r = new TileRecorder({ maxLineLen: 5 });
    r.record('t1', 'abcdefgh');
    expect(r.tail('t1', 1)[0]).toBe('abcde\u2026[truncated]');
  });

  it('tail returns the last n lines', () => {
    const r = new TileRecorder();
    r.record('t1', 'a\r\nb\r\nc\r\nd\r\ne');
    expect(r.tail('t1', 2)).toEqual(['d', 'e']);
    expect(r.tail('t1', 99)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('search matches across the ring with a limit and /g-safe regexes', () => {
    const r = new TileRecorder();
    r.record('t1', 'foo\r\nerror: boom\r\nbar\r\nerror: x\r\nerror: y');
    expect(r.search('t1', /error: (?:boom|x)/)).toEqual(['error: boom', 'error: x']);
    expect(r.search('t1', /error/, 1)).toEqual(['error: boom']);
    const re = /error/g;
    expect(r.search('t1', re)).toHaveLength(3);
    expect(re.lastIndex).toBe(0);
  });

  it('full returns the entire recording including the live viewport', () => {
    const r = new TileRecorder();
    r.record('t1', 'a\r\nb\r\nc\r\n');
    r.record('t1', 'd\r\nlive-here');
    expect(r.full('t1')).toEqual(['a', 'b', 'c', 'd', 'live-here']);
    expect(r.tail('t1', 2)).toEqual(['d', 'live-here']);
  });

  it('keeps the newest 5000 committed lines by default plus the live viewport', () => {
    const r = new TileRecorder();
    for (let i = 1; i <= 5100; i += 1) r.record('t1', `line-${i}\r\n`);
    // 5100 lines on a 40-row screen: 5061 scroll into scrollback, the ring
    // keeps the newest 5000 (line-62..line-5061), the viewport adds
    // line-5062..line-5100
    const all = r.full('t1');
    expect(all.length).toBe(5039);
    expect(all[0]).toBe('line-62');
    expect(all[5038]).toBe('line-5100');
  });

  it('has() is true only after content, summary reports readable lines', () => {
    const r = new TileRecorder();
    expect(r.has('t1')).toBe(false);
    r.record('t1', 'x\r\n');
    expect(r.has('t1')).toBe(true);
    expect(r.summary('t1').lines).toBe(1);
    r.record('t2', '');
    expect(r.has('t2')).toBe(false);
  });

  it('separates tiles from each other', () => {
    const r = new TileRecorder();
    r.record('t1', 'one');
    r.record('t2', 'two\r\nthree');
    expect(r.tail('t1', 1)).toEqual(['one']);
    expect(r.tail('t2', 2)).toEqual(['two', 'three']);
  });
});

describe('terminal emulation (opencode TUI fidelity)', () => {
  it('overwrites in place on \\r instead of merging (real terminal behavior)', () => {
    const r = new TileRecorder();
    // old code produced 'abcdefxy' (merged); a real terminal leaves the tail
    r.record('t1', 'abcdef\rxy\r\n');
    expect(r.tail('t1', 1)).toEqual(['xycdef']);
  });

  it('repaints a model header cleanly when the line is erased first (ESC[K)', () => {
    const r = new TileRecorder();
    r.record('t1', 'model: sonnet');
    r.record('t1', '\r\x1b[Kmodel: opus\r\n');
    expect(r.tail('t1', 1)).toEqual(['model: opus']);
    expect(r.full('t1').join('\n')).not.toContain('sonnet');
  });

  it('collapses a \\r progress-bar redraw into the final frame', () => {
    const r = new TileRecorder();
    r.record('t1', '[#.....] 10%\r[#==...] 50%\r[#=====] 100%\r\n');
    expect(r.tail('t1', 1)).toEqual(['[#=====] 100%']);
  });

  it('handles cursor-up overwrites of a prior line in the live view', () => {
    const r = new TileRecorder();
    r.record('t1', 'line A\r\nline B\r\n');
    r.record('t1', '\x1b[ALINEB2');
    // the cursor-up moved up and overwrote "line B" in place (same length)
    expect(r.tail('t1', 1)[0]).toBe('LINEB2');
  });

  it('ESC[2J wipes the viewport rows (real terminal behavior — nothing was scrolled yet)', () => {
    const r = new TileRecorder();
    r.record('t1', 'hist1\r\nhist2\r\n');
    r.record('t1', '\x1b[2Jfresh\r\n');
    expect(r.full('t1')).toEqual(['fresh']);
  });

  it('keeps scrolled history across ESC[2J (history only survives once committed)', () => {
    const r = new TileRecorder();
    for (let i = 1; i <= 45; i += 1) r.record('t1', `hist${i}\r\n`);
    r.record('t1', '\x1b[2Jfresh\r\n');
    const full = r.full('t1');
    expect(full[0]).toBe('hist1');
    expect(full[full.length - 1]).toBe('fresh');
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

describe('alternate screen (full-screen TUI frames)', () => {
  it('emits changed alt-frame rows and does not leak them into normal scrollback after exit', () => {
    const r = new TileRecorder();
    // opencode-style: enter the alt screen, paint a frame via absolute
    // cursor moves, redraw part of it, then exit and print a normal line
    r.record('t1', 'before\r\n');
    r.record('t1', '\x1b[?1049h\x1b[2J\x1b[Hframe-1');
    r.record('t1', '\x1b[Hframe-2\r\n');
    const during = r.full('t1');
    // alt-frame rows commit as changed lines while the TUI runs; the normal
    // screen's 'before' is hidden exactly as a real terminal hides it
    expect(during[0]).toBe('frame-1');
    expect(during).toContain('frame-2');
    r.record('t1', '\x1b[?1049l after\r\n');
    const after = r.full('t1');
    // the frames appear once each, then the restored normal screen continues
    expect(after.filter((l) => l.startsWith('frame-')).length).toBeLessThanOrEqual(2);
    expect(after[after.length - 1]).toBe(' after');
  });

  it('shows the alt frame as the live viewport while the TUI runs', () => {
    const r = new TileRecorder();
    r.record('t1', '\x1b[?1049h\x1b[H╭─ opencode ─╮');
    r.record('t1', '\x1b[1;5Hthinking...');
    const view = r.tail('t1', 5);
    expect(view.join(' ')).toContain('opencode');
    expect(view.join(' ')).toContain('thinking');
  });
});
