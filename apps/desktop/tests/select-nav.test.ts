import { describe, expect, it } from 'vitest';
import { selectInit, selectReduce, type SelectOption } from '../src/select-nav.js';

const OPTS: SelectOption[] = [
  { value: '', label: 'auto' },
  { value: 'a', label: 'alpha' },
  { value: 'b', label: 'beta' },
  { value: 'g', label: 'gamma' },
];

describe('selectReduce', () => {
  it('opens and closes', () => {
    let s = selectReduce(selectInit, { t: 'open' }, OPTS);
    expect(s.open).toBe(true);
    s = selectReduce(s, { t: 'close' }, OPTS);
    expect(s.open).toBe(false);
    expect(s.typed).toBe('');
  });

  it('arrows wrap around', () => {
    let s = selectReduce(selectInit, { t: 'open' }, OPTS);
    s = selectReduce(s, { t: 'move', d: -1 }, OPTS);
    expect(s.active).toBe(3);
    s = selectReduce(s, { t: 'move', d: 1 }, OPTS);
    expect(s.active).toBe(0);
    s = selectReduce(s, { t: 'move', d: 1 }, OPTS);
    expect(s.active).toBe(1);
  });

  it('home and end jump to the extremes', () => {
    let s = selectReduce(selectInit, { t: 'end' }, OPTS);
    expect(s.active).toBe(3);
    s = selectReduce(s, { t: 'home' }, OPTS);
    expect(s.active).toBe(0);
  });

  it('typeahead jumps to the first prefix match', () => {
    const s = selectReduce(selectInit, { t: 'type', ch: 'g', now: 1000 }, OPTS);
    expect(s.active).toBe(3);
    expect(s.typed).toBe('g');
  });

  it('typeahead buffers within 500ms and resets after', () => {
    let s = selectReduce(selectInit, { t: 'type', ch: 'b', now: 1000 }, OPTS);
    expect(s.active).toBe(2);
    s = selectReduce(s, { t: 'type', ch: 'e', now: 1300 }, OPTS);
    expect(s.typed).toBe('be');
    expect(s.active).toBe(2);
    s = selectReduce(s, { t: 'type', ch: 'a', now: 2500 }, OPTS);
    expect(s.typed).toBe('a');
    expect(s.active).toBe(0); // 'auto' is the first 'a' prefix
  });

  it('typeahead keeps the buffer when nothing matches', () => {
    const s = selectReduce(selectInit, { t: 'type', ch: 'z', now: 1000 }, OPTS);
    expect(s.typed).toBe('z');
    expect(s.active).toBe(0);
  });

  it('setIndex clamps', () => {
    let s = selectReduce(selectInit, { t: 'setIndex', i: 99 }, OPTS);
    expect(s.active).toBe(3);
    s = selectReduce(s, { t: 'setIndex', i: -5 }, OPTS);
    expect(s.active).toBe(0);
  });

  it('commit closes and clears the buffer', () => {
    let s = selectReduce(selectInit, { t: 'open' }, OPTS);
    s = selectReduce(s, { t: 'commit' }, OPTS);
    expect(s.open).toBe(false);
    expect(s.typed).toBe('');
  });

  it('empty options are safe', () => {
    let s = selectReduce(selectInit, { t: 'move', d: 1 }, []);
    expect(s.active).toBe(0);
    s = selectReduce(s, { t: 'type', ch: 'a', now: 0 }, []);
    expect(s.active).toBe(0);
  });
});

describe('typeahead from a non-initial highlight', () => {
  it('a no-match typeahead keeps the current highlight instead of jumping to 0', () => {
    const down = selectReduce(selectInit, { t: 'move', d: 1 }, OPTS);
    expect(down.active).toBe(1);
    const miss = selectReduce(down, { t: 'type', ch: 'z', now: 1000 }, OPTS);
    expect(miss.active).toBe(1);
    expect(miss.typed).toBe('z');
  });
});
