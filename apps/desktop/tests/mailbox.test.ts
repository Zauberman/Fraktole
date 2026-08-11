import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailboxRouter, echoText, messageId, routeMessage } from '../electron/mailbox.js';
import type { FraktoleMessage, SessionFile } from '../src/shared/ipc.js';

function msg(over: Partial<FraktoleMessage>): FraktoleMessage {
  return {
    id: 'm-1-1',
    from: 'agent-1',
    to: 'orchestrator',
    kind: 'result',
    body: 'done',
    at: 1000,
    ...over,
  };
}

describe('routeMessage', () => {
  it('allows agent → orchestrator', () => {
    expect(routeMessage(msg({}), 'agent')).toBe('ok');
  });

  it('allows orchestrator → any agent', () => {
    expect(routeMessage(msg({ from: 'orchestrator', to: 'agent-7', kind: 'task' }), 'judge')).toBe('ok');
  });

  it('forbids agent → agent (star topology)', () => {
    expect(routeMessage(msg({ to: 'agent-2' }), 'agent')).toBe('forbidden');
  });

  it('forbids self-messaging', () => {
    expect(routeMessage(msg({ from: 'agent-1', to: 'agent-1' }), 'judge')).toBe('forbidden');
  });

  it('rejects malformed messages', () => {
    expect(routeMessage(msg({ kind: 'teleport' as 'task' }), 'agent')).toBe('malformed');
    expect(routeMessage(msg({ to: '' }), 'agent')).toBe('forbidden');
    expect(routeMessage(msg({ body: 42 as unknown as string }), 'agent')).toBe('malformed');
    expect(routeMessage({} as FraktoleMessage, 'agent')).toBe('malformed');
    expect(routeMessage(null as unknown as FraktoleMessage, 'agent')).toBe('malformed');
  });
});

describe('echoText', () => {
  it('renders the visible terminal banner', () => {
    const out = echoText('orchestrator', 'agent-2', 'task', 'review this');
    expect(out).toContain('[fraktole]');
    expect(out).toContain('orchestrator');
    expect(out).toContain('agent-2');
    expect(out).toContain('(task)');
    expect(out).toContain('review this');
  });
});

describe('messageId', () => {
  it('is unique within a session timeline', () => {
    const ids = new Set(Array.from({ length: 50 }, () => messageId()));
    expect(ids.size).toBe(50);
  });
});

function session(id: string): SessionFile {
  return {
    version: 1,
    id,
    name: 't',
    createdAt: 1,
    updatedAt: 1,
    nextAgentSeq: 3,
    judge: null,
    tree: null,
    tiles: [
      { agentId: 'agent-1', cwd: '/tmp/a' },
      { agentId: 'agent-2', cwd: '/tmp/b' },
    ],
  };
}

describe('MailboxRouter end-to-end', () => {
  it('routes agent → orchestrator: log, judge inbox, echo, emit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frakt-mail-'));
    const current: SessionFile | null = session('s1');
    const writes: string[] = [];
    const emitted: FraktoleMessage[] = [];
    const router = new MailboxRouter({
      root,
      currentSession: () => current,
      tileOfAgent: (agentId) => (agentId === 'orchestrator' ? 'orchestrator' : `tile-of-${agentId}`),
      write: (tileId, text) => writes.push(`${tileId}:${text}`),
      emit: (m) => emitted.push(m),
    });
    router.start('s1');

    await router.deliver(msg({ id: 'm-9-1', from: 'agent-1', to: 'orchestrator' }), 'agent-1');

    const log = await readFile(join(root, 's1', 'messages.jsonl'), 'utf8');
    expect(log).toContain('"id":"m-9-1"');
    const inboxFiles = await readdir(join(root, 's1', 'agents', 'orchestrator', 'inbox'));
    expect(inboxFiles).toContain('m-9-1.json');
    expect(writes.some((w) => w.startsWith('orchestrator:') && w.includes('[fraktole]'))).toBe(true);
    expect(emitted.map((m) => m.id)).toEqual(['m-9-1']);
    await rm(root, { recursive: true, force: true });
  });

  it('routes orchestrator → agent: agent inbox + echo into the agent tile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frakt-mail-'));
    const current: SessionFile | null = session('s2');
    const writes: string[] = [];
    const router = new MailboxRouter({
      root,
      currentSession: () => current,
      tileOfAgent: (agentId) => `tile-of-${agentId}`,
      write: (tileId, text) => writes.push(`${tileId}:${text}`),
      emit: () => undefined,
    });

    await router.sendFromOrchestrator(
      msg({ id: 'm-3-1', from: 'orchestrator', to: 'agent-2', kind: 'task', body: 'go' }),
    );

    const inboxFiles = await readdir(join(root, 's2', 'agents', 'agent-2', 'inbox'));
    expect(inboxFiles).toContain('m-3-1.json');
    expect(writes.some((w) => w.startsWith('tile-of-agent-2:') && w.includes('go'))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('deliver is idempotent by message id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frakt-mail-'));
    const current: SessionFile | null = session('s3');
    const router = new MailboxRouter({
      root,
      currentSession: () => current,
      tileOfAgent: () => null,
      write: () => undefined,
      emit: () => undefined,
    });
    await router.deliver(msg({ id: 'm-7-1', from: 'agent-1' }), 'agent-1');
    await router.deliver(msg({ id: 'm-7-1', from: 'agent-1' }), 'agent-1');
    const log = await readFile(join(root, 's3', 'messages.jsonl'), 'utf8');
    expect(log.match(/m-7-1/g)).toHaveLength(1);
    await rm(root, { recursive: true, force: true });
  });

  it('sendFromOrchestrator rejects unknown targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frakt-mail-'));
    const current: SessionFile | null = session('s4');
    const router = new MailboxRouter({
      root,
      currentSession: () => current,
      tileOfAgent: () => null,
      write: () => undefined,
      emit: () => undefined,
    });
    const ok = await router.sendFromOrchestrator(
      msg({ id: 'm-5-1', from: 'orchestrator', to: 'agent-99', kind: 'task' }),
    );
    expect(ok).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('ingestOutboxFile consumes an agent-written file and routes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frakt-mail-'));
    const current: SessionFile | null = session('s5');
    const router = new MailboxRouter({
      root,
      currentSession: () => current,
      tileOfAgent: () => null,
      write: () => undefined,
      emit: () => undefined,
    });
    const outbox = join(root, 's5', 'agents', 'agent-1', 'outbox');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(outbox, { recursive: true });
    await writeFile(join(outbox, 'm-2-1.json'), JSON.stringify(msg({ id: 'm-2-1', from: 'agent-1' })));

    await router.scanOutboxes();

    const remaining = await readdir(outbox);
    expect(remaining).toEqual([]);
    const inbox = await readdir(join(root, 's5', 'agents', 'orchestrator', 'inbox'));
    expect(inbox).toContain('m-2-1.json');
    await rm(root, { recursive: true, force: true });
  });
});
