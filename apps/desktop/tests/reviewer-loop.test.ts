import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewerHost, type ReviewerConfig } from '../electron/reviewer.js';
import type { ReviewerToolContext } from '../electron/reviewer-tools.js';
import { TileRecorder } from '../electron/tile-recorder.js';
import type { ProviderClient, ProviderMsg } from '../electron/reviewer/providers.js';

type ScriptEntry = { text: string; toolCalls: ProviderMsg['toolCalls'] } | { hang: boolean };

class FakeProvider implements ProviderClient {
  readonly name = 'openai' as const;
  complete = vi.fn();
  constructor(script: ScriptEntry[]) {
    this.complete.mockImplementation((opts: { messages: ProviderMsg[]; signal: AbortSignal }) => {
      const entry = script.shift()!;
      if (entry && 'hang' in entry) {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return Promise.resolve({ text: entry.text, toolCalls: entry.toolCalls ?? [] });
    });
  }
}

function recorderWith(content: string): TileRecorder {
  const r = new TileRecorder();
  r.record('tile-1', content);
  return r;
}

function ctxFor(recorder: TileRecorder, opts: Partial<ReviewerToolContext> = {}): ReviewerToolContext {
  return {
    sessionId: 's1',
    sessionDir: '/tmp/sessions/s1',
    cwd: '/tmp/proj',
    recorder,
    router: {
      sendFromOrchestrator: vi.fn(async () => true) as never,
    },
    tileOfAgent: (agentId: string) => (agentId === 'agent-1' ? 'tile-1' : null),
    agentOfTile: (tileId: string) => (tileId === 'tile-1' ? 'agent-1' : null),
    cwdOfAgent: () => '/tmp/proj/agent-1',
    ...opts,
  };
}

function makeHost(script: ScriptEntry[], recorder: TileRecorder, extra: Partial<{ config: ReviewerConfig; dir: string }> = {}) {
  const provider = new FakeProvider(script);
  const events: string[] = [];
  const host = new ReviewerHost({
    getConfig: async (): Promise<ReviewerConfig> => extra.config ?? { provider: 'ollama', model: 'm' },
    sessionId: 's1',
    sessionDir: extra.dir ?? '/tmp/sessions/s1',
    cwd: '/tmp/proj',
    recorder,
    toolContext: ctxFor(recorder),
    createProvider: () => provider,
    conversationFile: extra.dir ? join(extra.dir, 'conversation.jsonl') : uniqueConversationFile(),
    emit: {
      status: (s) => events.push(`status:${s}`),
      stream: (d) => events.push(`stream:${d}`),
      toolCall: (ev) => events.push(`tool:${ev.name}:${ev.state}`),
      message: () => events.push('msg'),
    },
  });
  return { host, provider, events };
}

const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

let convSeq = 0;
function uniqueConversationFile(): string {
  convSeq += 1;
  return `/tmp/fraktole-reviewer-test-${process.pid}-${convSeq}/conversation.jsonl`;
}

describe('ReviewerHost', () => {
  it('starts unconfigured when the API key is missing', async () => {
    const recorder = new TileRecorder();
    const { host } = makeHost([], recorder, { config: { provider: 'openai', model: 'm', apiKeyEnv: 'FRAKTOLE_TEST_KEY' } });
    const ok = await host.start();
    expect(ok).toBe(false);
    expect(host.status).toBe('unconfigured');
  });

  it('runs the tool loop: read_tile executes against the real recording, then final text', async () => {
    const recorder = recorderWith('boot log\necho HARNESS-42\nHARNESS-42\nprompt$');
    const { host, provider, events } = makeHost(
      [
        { text: '', toolCalls: [{ id: 'c1', name: 'read_tile', args: { agentId: 'agent-1', tail: 5 } }] },
        { text: 'OBSERVED', toolCalls: [] },
      ],
      recorder,
    );
    await host.start();
    await host.prompt('what is running?');
    await settle(80);
    expect(provider.complete).toHaveBeenCalledTimes(2);
    const contents = host.conversation.map((e) => e.content);
    expect(contents).toContain('OBSERVED');
    expect(contents.some((c) => c.includes('HARNESS-42'))).toBe(true);
    expect(events).toContain('tool:read_tile:start');
    expect(events).toContain('tool:read_tile:done');
  });

  it('queues turns while a run is in flight and processes them in order', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'a', toolCalls: [] }, { text: 'b', toolCalls: [] }], recorder);
    await host.start();
    void host.prompt('first');
    void host.prompt('second');
    await settle(80);
    expect(provider.complete).toHaveBeenCalledTimes(2);
    const users = host.conversation.filter((e) => e.role === 'user').map((e) => e.content);
    expect(users).toEqual(['first', 'second']);
  });

  it('send_message routes through the router', async () => {
    const recorder = new TileRecorder();
    const router = vi.fn(async () => true);
    const ctx = ctxFor(recorder, { router: { sendFromOrchestrator: router as never } });
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-reviewer-'));
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'send_message', args: { to: 'agent-1', kind: 'task', body: 'go' } }] },
      { text: 'sent', toolCalls: [] },
    ]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: dir,
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctx,
      createProvider: () => provider,
      conversationFile: join(dir, 'conversation.jsonl'),
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined },
    });
    await host.start();
    await host.prompt('delegate');
    await settle(80);
    expect(router).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'agent-1', kind: 'task', body: 'go', from: 'orchestrator' }),
    );
  });

  it('marks error status when the provider fails', async () => {
    const recorder = new TileRecorder();
    const provider = new FakeProvider([{ text: '', toolCalls: [] }]);
    provider.complete.mockRejectedValueOnce(new Error('boom'));
    const events: string[] = [];
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctxFor(recorder),
      createProvider: () => provider,
      emit: { status: (s) => events.push(`status:${s}`), stream: () => undefined, toolCall: () => undefined, message: () => undefined },
    });
    await host.start();
    await host.prompt('x');
    await settle(80);
    expect(host.status).toBe('error');
    expect(events).toContain('status:error');
  });

  it('cancel aborts an in-flight run without erroring', async () => {
    const recorder = new TileRecorder();
    const { host } = makeHost([{ hang: true }], recorder);
    await host.start();
    void host.prompt('hang');
    await settle(20);
    host.cancel();
    await settle(40);
    expect(host.status).toBe('running');
  });

  it('persists the conversation and restart truncates it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-reviewer-'));
    const recorder = new TileRecorder();
    const { host } = makeHost([{ text: 'hello', toolCalls: [] }], recorder, { dir });
    await host.start();
    await host.prompt('hi');
    await settle(60);
    const files = await readdir(join(dir));
    expect(files).toContain('conversation.jsonl');
    const raw = await readFile(join(dir, 'conversation.jsonl'), 'utf8');
    expect(raw).toContain('hello');
    await host.restart();
    await settle(30);
    expect(host.status).toBe('running');
    expect(host.conversation.length).toBe(1); // system prompt only
  });

  it('compacts the conversation when it outgrows the budget', async () => {
    const recorder = recorderWith('x'.repeat(3000));
    const script: ScriptEntry[] = [];
    for (let i = 0; i < 24; i++) {
      script.push({ text: '', toolCalls: [{ id: `c${i}`, name: 'read_tile', args: { agentId: 'agent-1', tail: 2000 } }] });
    }
    script.push({ text: 'done', toolCalls: [] });
    const { host } = makeHost(script, recorder);
    await host.start();
    await host.prompt('dig');
    await settle(400);
    expect(host.conversation.length).toBeLessThan(51); // compaction dropped exchanges
    expect(host.conversation[0]!.role).toBe('system');
    expect(host.conversation.some((e) => e.content.includes('context compacted'))).toBe(true);
  });
});
