import {
  makeEnvelope,
  type EnvelopeFor,
  type EventEnvelope,
  type EventKind,
  type EventPayloads,
} from '@fraktole/core';

export class EventBus {
  onPublish?: (ev: EventEnvelope) => void;

  private seqCounter = 0;
  private readonly subs = new Set<(ev: EventEnvelope) => void>();
  private readonly ring: EventEnvelope[] = [];
  private readonly ringCapacity = 5000;

  get lastSeq(): number {
    return this.seqCounter - 1;
  }

  publish<K extends EventKind>(
    kind: K,
    taskId: string | undefined,
    payload: EventPayloads[K],
  ): EnvelopeFor<K> {
    const ev = makeEnvelope(kind, taskId, payload, this.seqCounter++);
    // Generic EnvelopeFor<K> -> union EventEnvelope: TS cannot distribute the generic.
    const union: EventEnvelope = ev as EventEnvelope;
    this.ring.push(union);
    if (this.ring.length > this.ringCapacity) {
      this.ring.splice(0, this.ring.length - this.ringCapacity);
    }
    this.onPublish?.(union);
    for (const fn of [...this.subs]) {
      fn(union);
    }
    return ev;
  }

  subscribe(fn: (ev: EventEnvelope) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  replaySince(n: number): EventEnvelope[] {
    return this.ring.filter((ev) => ev.seq > n);
  }
}
