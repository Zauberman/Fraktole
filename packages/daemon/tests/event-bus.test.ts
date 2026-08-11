import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/event-bus.js';

describe('EventBus', () => {
  it('publishes envelopes with increasing seq and forwards to subscribers', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe((ev) => seen.push(ev.kind));

    bus.publish('TaskPlanning', 't1', { taskId: 't1' });
    bus.publish('TaskFailed', 't1', { taskId: 't1', reason: 'x' });

    expect(seen).toEqual(['TaskPlanning', 'TaskFailed']);
    expect(bus.lastSeq).toBe(1);
    unsub();
    bus.publish('TaskCancelled', 't1', { taskId: 't1' });
    expect(seen).toEqual(['TaskPlanning', 'TaskFailed']);
  });

  it('replays envelopes after a given seq from the ring buffer', () => {
    const bus = new EventBus();
    for (let i = 0; i < 10; i++) {
      bus.publish('TaskQueued', 't1', { taskId: 't1' });
    }
    const replayed = bus.replaySince(7);
    expect(replayed.map((ev) => ev.seq)).toEqual([8, 9]);
  });
});
