import { describe, expect, it } from 'vitest';
import { nextFocusTarget } from '../src/focus-cycle.js';

const T1 = 'tile-1';
const T2 = 'tile-2';
const T3 = 'tile-3';

describe('nextFocusTarget', () => {
  it('next from the reviewer lands on the first tile; prev lands on the last', () => {
    expect(nextFocusTarget([T1, T2, T3], null, true, 'next')).toEqual({ kind: 'tile', id: T1 });
    expect(nextFocusTarget([T1, T2, T3], null, true, 'prev')).toEqual({ kind: 'tile', id: T3 });
  });

  it('prev from the leftmost tile moves into the reviewer', () => {
    expect(nextFocusTarget([T1, T2, T3], T1, false, 'prev')).toEqual({ kind: 'reviewer' });
  });

  it('tile-to-tile movement wraps within the tile ring', () => {
    expect(nextFocusTarget([T1, T2, T3], T2, false, 'next')).toEqual({ kind: 'tile', id: T3 });
    expect(nextFocusTarget([T1, T2, T3], T3, false, 'next')).toEqual({ kind: 'tile', id: T1 });
    expect(nextFocusTarget([T1, T2, T3], T3, false, 'prev')).toEqual({ kind: 'tile', id: T2 });
  });

  it('a single tile wraps to itself on next, and moves to the reviewer on prev', () => {
    expect(nextFocusTarget([T1], T1, false, 'next')).toEqual({ kind: 'tile', id: T1 });
    expect(nextFocusTarget([T1], T1, false, 'prev')).toEqual({ kind: 'reviewer' });
  });

  it('an empty tree leaves everything on the reviewer', () => {
    expect(nextFocusTarget([], null, true, 'next')).toEqual({ kind: 'reviewer' });
    expect(nextFocusTarget([], null, false, 'next')).toEqual({ kind: 'reviewer' });
    expect(nextFocusTarget([], null, false, 'prev')).toEqual({ kind: 'reviewer' });
  });

  it('unfocused with tiles: next → first tile, prev → reviewer', () => {
    expect(nextFocusTarget([T1, T2], null, false, 'next')).toEqual({ kind: 'tile', id: T1 });
    expect(nextFocusTarget([T1, T2], null, false, 'prev')).toEqual({ kind: 'reviewer' });
  });

  it('the reviewer stays put when it is the only target', () => {
    expect(nextFocusTarget([], null, true, 'prev')).toEqual({ kind: 'reviewer' });
    expect(nextFocusTarget([], null, true, 'next')).toEqual({ kind: 'reviewer' });
  });
});
