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
