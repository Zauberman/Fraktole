import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewerHost, type ReviewerConfig } from '../electron/reviewer.js';
import type { ReviewerToolContext } from '../electron/reviewer-tools.js';
import type { ReviewerState } from '../src/shared/ipc.js';
import type { FraktoleMessage } from '../src/shared/ipc.js';
import { TileRecorder } from '../electron/tile-recorder.js';
import type { ProviderClient, ProviderMsg } from '../electron/reviewer/providers.js';

type ScriptEntry =
  | { text: string; toolCalls: ProviderMsg['toolCalls']; thinking?: string; usage?: { inputTokens: number; cachedTokens: number; outputTokens: number }; finishReason?: string; delay?: number }
  | { hang: boolean }
  | { fail: boolean }
  | { failWith: string };

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
      if (entry && 'fail' in entry) {
        return Promise.reject(new Error('provider boom'));
      }
      if (entry && 'failWith' in entry) {
        return Promise.reject(new Error(entry.failWith));
      }
      const body = {
        text: entry.text,
        toolCalls: entry.toolCalls ?? [],
        thinking: entry.thinking ?? '',
        finishReason: entry.finishReason ?? 'stop',
        ...(entry.usage ? { usage: entry.usage } : {}),
      };
      return entry.delay
        ? new Promise((resolve) => setTimeout(() => resolve(body), entry.delay))
        : Promise.resolve(body);
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
    isHarnessTile: (tileId: string) => tileId === 'tile-1',
    cwdOfAgent: () => '/tmp/proj/agent-1',
    killAgent: vi.fn(async () => 'killed tile-1') as never,
    spawnAgent: vi.fn(async (kind: string, cwd: string) => `spawned agent a-9 (kind ${kind}, cwd ${cwd || 'root'})`) as never,
    agentCount: vi.fn(() => 0) as never,
    getAgentCommand: vi.fn(() => '') as never,
    ...opts,
  };
}

let hostSeq = 0;
function makeHost(script: ScriptEntry[], recorder: TileRecorder, extra: Partial<{ config: ReviewerConfig; dir: string; retryDelayMs: number; loadingRetryMs: number; contextBudgetTokens: number; stallTimeoutMs: number; askTimeoutMs: number; cwd: string; probe: () => Promise<unknown>; forkProject: (variant: string, keepExisting: boolean) => Promise<{ ok: true; path: string } | { ok: false; error: string }> }> = {}) {
  const dir = extra.dir ?? join(tmpdir(), `fraktole-reviewer-host-${process.pid}-${++hostSeq}`);
  const provider = new FakeProvider(script);
  const events: string[] = [];
  const asks: Array<{ id: string; kind: string; agentId?: string }> = [];
  const host = new ReviewerHost({
    getConfig: async (): Promise<ReviewerConfig> => extra.config ?? { provider: 'ollama', model: 'm' },
    sessionId: 's1',
    sessionDir: dir,
    cwd: extra.cwd ?? '/tmp/proj',
    recorder,
    toolContext: ctxFor(recorder),
    createProvider: () => provider,
    forkProject: extra.forkProject,
    retryDelayMs: extra.retryDelayMs ?? 1,
    loadingRetryMs: extra.loadingRetryMs,
    stallTimeoutMs: extra.stallTimeoutMs,
    contextBudgetTokens: extra.contextBudgetTokens,
    askTimeoutMs: extra.askTimeoutMs,
    probe: extra.probe as never,
    conversationFile: extra.dir ? join(extra.dir, 'conversation.jsonl') : uniqueConversationFile(),
    emit: {
      status: (s, e) => {
        events.push(`status:${s}`);
        if (e) events.push(`status-error:${e}`);
      },
      stream: (ev) => events.push(`stream:${ev.delta}${ev.thinking ? '|think:' + ev.thinking : ''}`),
      toolCall: (ev) => events.push(`tool:${ev.name}:${ev.state}`),
      message: () => events.push('msg'),
      goal: (ev) => events.push(`goal:${ev.goal?.state ?? 'none'}`),
      question: (ev) => {
        asks.push({ id: ev.askId, kind: ev.kind, agentId: ev.agentId });
        events.push(`question:${ev.kind}`);
      },
      usage: (ev) => events.push(`usage:${ev.inputTokens}:${ev.cachedTokens}:${ev.outputTokens}`),
      recap: (recap) => events.push(`recap:${recap.text}`),
      budget: (info) => events.push(`budget:${info.contextTokens}`),
      prevError: (message) => events.push(`prevError:${message}`),
    },
  });
  return { host, provider, events, asks };
}

const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

let convSeq = 0;
function uniqueConversationFile(): string {
  convSeq += 1;
  return `/tmp/fraktole-reviewer-test-${process.pid}-${convSeq}/conversation.jsonl`;
}

describe('ReviewerHost', () => {
  it('resolves to ollama when no key is available — the key decides everything', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, {
      config: { provider: 'openai' }, // a stale hint cannot override keylessness
    });
    await host.start();
    expect(host.status).toBe('running');
    await host.prompt('x');
    await settle(60);
    const call = provider.complete.mock.calls[0]![0] as { model: string; baseUrl: string; apiKey: string };
    expect(call.model).toBe('qwen2.5');
    expect(call.baseUrl).toBe('http://localhost:11434');
  });

  it('starts keyless for a local-server pick with auth optional (llama.cpp)', async () => {
    const recorder = new TileRecorder();
    const { host } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, {
      config: { providerId: 'llamacpp', model: 'local-model' },
    });
    expect(await host.start()).toBe(true);
    expect(host.status).toBe('running');
    await host.prompt('hi');
    await settle(60);
  });

  it('still refuses to start keyless when the picked provider demands a key', async () => {
    const recorder = new TileRecorder();
    const { host } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, {
      config: { providerId: 'openai', model: 'gpt-4o' },
    });
    expect(await host.start()).toBe(false);
    expect(host.status).toBe('unconfigured');
  });

  it('resolves provider, endpoint and model from a pasted key', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'hi', toolCalls: [] }], recorder, {
      config: { apiKey: 'sk-ant-api03-test' },
    });
    await host.start();
    expect(host.status).toBe('running');
    await host.prompt('hello');
    await settle(60);
    const call = provider.complete.mock.calls[0]![0] as { model: string; apiKey: string; baseUrl: string };
    expect(call.model).toBe('claude-sonnet-4-5');
    expect(call.baseUrl).toBe('https://api.anthropic.com');
    expect(call.apiKey).toBe('sk-ant-api03-test');
  });

  it('an env-var fallback key still works', async () => {
    process.env.FRAKTOLE_ENV_FALLBACK_KEY = 'sk-proj-test';
    try {
      const recorder = new TileRecorder();
      const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, {
        config: { apiKeyEnv: 'FRAKTOLE_ENV_FALLBACK_KEY' },
      });
      await host.start();
      expect(host.status).toBe('running');
      await host.prompt('x');
      await settle(60);
      const call = provider.complete.mock.calls[0]![0] as { baseUrl: string };
      expect(call.baseUrl).toBe('https://api.openai.com/v1');
    } finally {
      delete process.env.FRAKTOLE_ENV_FALLBACK_KEY;
    }
  });

  it('a deepseek hint routes through the openai adapter to the deepseek endpoint', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, {
      config: { apiKey: 'sk-deepseek-key', provider: 'deepseek' },
    });
    await host.start();
    await host.prompt('x');
    await settle(60);
    const call = provider.complete.mock.calls[0]![0] as { model: string; baseUrl: string };
    expect(call.model).toBe('deepseek-v4-flash');
    expect(call.baseUrl).toBe('https://api.deepseek.com/v1');
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
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
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
    provider.complete.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom again'));
    const events: string[] = [];
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctxFor(recorder),
      createProvider: () => provider,
      retryDelayMs: 1,
      emit: { status: (s) => events.push(`status:${s}`), stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
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

  it('sanitizes emoji from agent messages before they enter the conversation', async () => {
    const recorder = new TileRecorder();
    const { host } = makeHost([{ text: 'ok', toolCalls: [] }], recorder);
    await host.start();
    host.onAgentMessage({
      id: 'm-1',
      from: 'agent-1',
      to: 'orchestrator',
      kind: 'result',
      body: 'done ✅ with 🚀 launch',
      at: Date.now(),
    });
    await settle(80);
    const users = host.conversation.filter((e) => e.role === 'user').map((e) => e.content);
    expect(users.some((u) => u.includes('done  with  launch'))).toBe(true);
    expect(users.some((u) => u.includes('\u{1F389}'))).toBe(false);
    expect(users.join(' ')).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('forced compact drops whole oldest turns but keeps the two newest', async () => {
    const recorder = recorderWith('x'.repeat(100));
    const script: ScriptEntry[] = [];
    for (let i = 0; i < 10; i++) {
      script.push({ text: '', toolCalls: [{ id: `c${i}`, name: 'read_tile', args: { agentId: 'agent-1', tail: 5 } }] });
    }
    script.push({ text: 'done', toolCalls: [] });
    script.push({ text: 'again', toolCalls: [] });
    script.push({ text: 'third', toolCalls: [] });
    const { host } = makeHost(script, recorder);
    await host.start();
    await host.prompt('dig deep');
    await settle(300);
    await host.prompt('and again');
    await settle(60);
    await host.prompt('third');
    await settle(60);
    const before = host.conversation.length;
    expect(before).toBeGreaterThan(10);
    host.compact();
    await settle(30);
    const after = host.conversation;
    expect(after.length).toBeLessThan(before);
    expect(after.some((e) => e.content.includes('context compacted'))).toBe(true);
    // the two newest turns survive (whole-turn floor)
    const users = after.filter((e) => e.role === 'user').map((e) => e.content);
    expect(users).toContain('and again');
    expect(users).toContain('third');
    // whole turns only: no tool message without its assistant owner
    for (let i = 1; i < after.length; i++) {
      if (after[i]!.role === 'tool') expect(after[i - 1]!.role).toBe('assistant');
    }
  });

  it('compacts the conversation when it outgrows the budget', async () => {
    const recorder = recorderWith('x'.repeat(3000));
    const script: ScriptEntry[] = [];
    for (let i = 0; i < 6; i++) {
      script.push({ text: '', toolCalls: [{ id: `c${i}`, name: 'read_tile', args: { agentId: 'agent-1', tail: 2000 } }] });
    }
    script.push({ text: 'done', toolCalls: [] });
    script.push({ text: 'again', toolCalls: [] });
    script.push({ text: 'third', toolCalls: [] });
    const { host } = makeHost(script, recorder, { contextBudgetTokens: 500 });
    await host.start();
    await host.prompt('dig');
    await settle(400);
    await host.prompt('again');
    await settle(60);
    await host.prompt('third');
    await settle(60);
    const conv = host.conversation;
    expect(conv[0]!.role).toBe('system');
    expect(conv.some((e) => e.content.includes('context compacted'))).toBe(true);
    const users = conv.filter((e) => e.role === 'user').map((e) => e.content);
    expect(users).toContain('third');
  });

  it('flows the model knobs into every provider complete call', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, {
      config: {
        provider: 'ollama',
        model: 'm',
        knobs: { contextTokens: 16384, maxOutputTokens: 2048, temperature: 0.2, think: true },
      },
    });
    await host.start();
    await host.prompt('hi');
    await settle(60);
    const call = provider.complete.mock.calls[0]![0] as { knobs?: unknown };
    expect(call.knobs).toEqual({ contextTokens: 16384, maxOutputTokens: 2048, temperature: 0.2, think: true });
  });

  it('knobs.contextTokens drives the compaction budget (config wins over the model guess)', async () => {
    const recorder = recorderWith('x'.repeat(3000));
    const script: ScriptEntry[] = [];
    for (let i = 0; i < 6; i++) {
      script.push({ text: '', toolCalls: [{ id: `c${i}`, name: 'read_tile', args: { agentId: 'agent-1', tail: 2000 } }] });
    }
    script.push({ text: 'done', toolCalls: [] });
    script.push({ text: 'again', toolCalls: [] });
    script.push({ text: 'third', toolCalls: [] });
    const { host } = makeHost(script, recorder, {
      config: { provider: 'ollama', model: 'm', knobs: { contextTokens: 500 } },
    });
    await host.start();
    await host.prompt('dig');
    await settle(400);
    await host.prompt('again');
    await settle(60);
    await host.prompt('third');
    await settle(60);
    const conv = host.conversation;
    expect(conv.some((e) => e.content.includes('context compacted'))).toBe(true);
    const users = conv.filter((e) => e.role === 'user').map((e) => e.content);
    expect(users).toContain('third');
  });

  it('setGoal persists the ledger; read_state and update_task work through the real tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-reviewer-'));
    const recorder = new TileRecorder();
    const { host, events } = makeHost(
      [
        {
          text: '',
          toolCalls: [
            { id: 'c1', name: 'read_state', args: {} },
            { id: 'c2', name: 'update_task', args: { title: 'build the widget', agentId: 'agent-1', status: 'active' } },
            { id: 'c3', name: 'update_task', args: { title: 'verify the build', status: 'done' } },
          ],
        },
        { text: 'ledger ok', toolCalls: [] },
      ],
      recorder,
      { dir },
    );
    await host.start();
    await host.setGoal('finish the release');
    await settle(120);
    expect(events).toContain('goal:active');
    const raw = await readFile(join(dir, 'reviewer', 'state.json'), 'utf8');
    expect(raw).toContain('finish the release');
    const contents = host.conversation.map((e) => e.content);
    expect(contents.some((c) => c.includes('"goal"') && c.includes('finish the release'))).toBe(true); // read_state result
    expect(host.conversation.some((e) => e.toolCalls?.some((c) => JSON.stringify(c.args).includes('build the widget')))).toBe(true); // update_task args
    const state = JSON.parse(raw) as ReviewerState;
    expect(state.goal?.state).toBe('active');
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks.some((t) => t.title === 'build the widget' && t.agentId === 'agent-1' && t.status === 'active')).toBe(true);
    expect(state.tasks.some((t) => t.title === 'verify the build' && t.status === 'done' && t.id.startsWith('t-'))).toBe(true);
  });

  it('the watchdog poll is silent without a goal', async () => {
    const recorder = recorderWith('boot\nlog');
    const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder);
    await host.start();
    host.pollNow();
    host.pollNow();
    await settle(80);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('with a goal, the watchdog wakes on tile activity but stays quiet without it', async () => {
    const recorder = new TileRecorder();
    recorder.record('tile-1', 'boot');
    const script: ScriptEntry[] = [
      { text: '', toolCalls: [{ id: 'c1', name: 'read_tile', args: { agentId: 'agent-1', tail: 10 } }] },
      { text: 'checked', toolCalls: [] },
      { text: 'woke on activity', toolCalls: [] },
      { text: 'woke on backstop', toolCalls: [] },
    ];
    const { host, provider } = makeHost(script, recorder);
    await host.start();
    await host.setGoal('watch the build');
    await settle(100);
    expect(provider.complete).toHaveBeenCalledTimes(2); // the [goal armed] tool loop
    expect(host.conversation.some((e) => e.content.includes('[goal: watch the build (active)]'))).toBe(true);

    recorder.record('tile-1', 'boot\r\nnew output');
    host.pollNow();
    await settle(100);
    expect(provider.complete).toHaveBeenCalledTimes(3); // activity delta woke the model
    expect(host.conversation.some((e) => e.content.includes('[watchdog] re-check progress'))).toBe(true);

    const beforeIdle = provider.complete.mock.calls.length;
    for (let i = 0; i < 5; i++) host.pollNow();
    await settle(80);
    expect(provider.complete).toHaveBeenCalledTimes(beforeIdle); // no delta, no wake

    for (let i = 0; i < 10; i++) host.pollNow(); // the 10th silent poll hits the backstop
    await settle(100);
    expect(provider.complete).toHaveBeenCalledTimes(beforeIdle + 1);
  });

  it('a GOAL-MET declaration marks the goal met and silences the watchdog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-reviewer-'));
    const recorder = new TileRecorder();
    const { host, provider, events } = makeHost([{ text: 'GOAL-MET: the widget is built, all green', toolCalls: [] }], recorder, { dir });
    await host.start();
    await host.setGoal('build the widget');
    await settle(100);
    expect(events).toContain('goal:met');
    const state = JSON.parse(await readFile(join(dir, 'reviewer', 'state.json'), 'utf8')) as ReviewerState;
    expect(state.goal?.state).toBe('met');
    const calls = provider.complete.mock.calls.length;
    recorder.record('tile-1', 'more output');
    host.pollNow();
    await settle(60);
    expect(provider.complete).toHaveBeenCalledTimes(calls); // met goal: poll stays silent
    expect(host.conversation.some((e) => e.content.includes('[watchdog]'))).toBe(false);
  });

  it('re-arming a met goal wakes the loop again', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost(
      [{ text: 'GOAL-MET: first goal done', toolCalls: [] }, { text: 'second goal engaged', toolCalls: [] }],
      recorder,
    );
    await host.start();
    await host.setGoal('first goal');
    await settle(500);
    await host.setGoal('second goal');
    await settle(500);
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(host.conversation.some((e) => e.content.includes('second goal engaged'))).toBe(true);
  });

  it('restart clears the goal and the task ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-reviewer-'));
    const recorder = new TileRecorder();
    const { host } = makeHost([{ text: 'GOAL-MET: done', toolCalls: [] }, { text: 'x', toolCalls: [] }], recorder, { dir });
    await host.start();
    await host.setGoal('clear me');
    await settle(100);
    await host.restart();
    await settle(60);
    const state = JSON.parse(await readFile(join(dir, 'reviewer', 'state.json'), 'utf8')) as ReviewerState;
    expect(state.goal).toBeNull();
    expect(state.tasks).toEqual([]);
  });

  it('every trigger carries the goal block, even after auto-compaction', async () => {
    const recorder = recorderWith('x'.repeat(3000));
    const script: ScriptEntry[] = [];
    for (let i = 0; i < 24; i++) {
      script.push({ text: '', toolCalls: [{ id: `c${i}`, name: 'read_tile', args: { agentId: 'agent-1', tail: 2000 } }] });
    }
    script.push({ text: 'done', toolCalls: [] });
    script.push({ text: 'again', toolCalls: [] });
    script.push({ text: 'third', toolCalls: [] });
    const { host } = makeHost(script, recorder, { contextBudgetTokens: 3000 });
    await host.start();
    await host.setGoal('big dig');
    await settle(500);
    await host.prompt('one more');
    await settle(60);
    await host.prompt('third');
    await settle(60);
    expect(host.conversation.some((e) => e.content.includes('context compacted'))).toBe(true);
    const lastUser = [...host.conversation].reverse().find((e) => e.role === 'user');
    expect(lastUser?.content.startsWith('[goal: big dig (active)]')).toBe(true);
  });

  it('ask_user suspends the loop until the user answers', async () => {
    const recorder = new TileRecorder();
    const { host, provider, asks } = makeHost(
      [
        { text: '', toolCalls: [{ id: 'c1', name: 'ask_user', args: { question: 'may I proceed?', kind: 'free' } }] },
        { text: 'final answer', toolCalls: [] },
      ],
      recorder,
    );
    await host.start();
    await host.prompt('check');
    await settle(100);
    expect(provider.complete).toHaveBeenCalledTimes(1); // suspended on the tool
    expect(asks).toHaveLength(1);
    expect(asks[0]!.kind).toBe('free');
    host.answerQuestion(asks[0]!.id, 'yes, go ahead');
    await settle(100);
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(host.conversation.some((e) => e.content.includes('user answered: yes, go ahead'))).toBe(true);
    expect(host.conversation.some((e) => e.content === 'final answer')).toBe(true);
  });

  it('restart rejects a pending question without erroring the harness', async () => {
    const recorder = new TileRecorder();
    const { host, provider, asks } = makeHost(
      [
        { text: '', toolCalls: [{ id: 'c1', name: 'ask_user', args: { question: 'waiting…', kind: 'free' } }] },
        { text: 'after restart', toolCalls: [] },
      ],
      recorder,
    );
    await host.start();
    await host.prompt('ask');
    await settle(120);
    expect(asks).toHaveLength(1);
    await host.restart();
    await settle(80);
    expect(host.status).toBe('running');
    await host.prompt('again');
    await settle(80);
    expect(provider.complete.mock.calls[provider.complete.mock.calls.length - 1]![0]).toBeTruthy();
    expect(host.conversation.some((e) => e.content === 'after restart')).toBe(true);
  });

  it('an answer with a stale askId is ignored', async () => {
    const recorder = new TileRecorder();
    const { host, provider, asks } = makeHost(
      [
        { text: '', toolCalls: [{ id: 'c1', name: 'ask_user', args: { question: 'q?', kind: 'free' } }] },
        { text: 'done', toolCalls: [] },
      ],
      recorder,
    );
    await host.start();
    await host.prompt('ask');
    await settle(80);
    host.answerQuestion('q-wrong-id', 'nope');
    await settle(60);
    expect(provider.complete).toHaveBeenCalledTimes(1); // still suspended
    host.answerQuestion(asks[0]!.id, 'ok');
    await settle(80);
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it('kill_agent kills directly without any confirmation', async () => {
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder);
    const asks: Array<{ kind: string }> = [];
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'kill_agent', args: { agentId: 'agent-1' } }] },
      { text: 'killed', toolCalls: [] },
    ]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctx,
      createProvider: () => provider,
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: (ev) => asks.push({ kind: ev.kind }), usage: () => undefined },
    });
    await host.start();
    await host.prompt('kill');
    await settle(80);
    // one tool call, one kill — no ask_user, no grant, no refusal
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(ctx.killAgent).toHaveBeenCalledTimes(1);
    expect(ctx.killAgent).toHaveBeenCalledWith('tile-1');
    expect(asks).toEqual([]);
    expect(host.conversation.some((e) => e.content.includes('killed tile-1'))).toBe(true);
    expect(host.status).toBe('running');
  });

  it('kill_agent refuses to kill the orchestrator', async () => {
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'kill_agent', args: { agentId: 'orchestrator' } }] },
      { text: 'cannot kill the orchestrator', toolCalls: [] },
    ]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctx,
      createProvider: () => provider,
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await host.start();
    await host.prompt('kill');
    await settle(80);
    expect(ctx.killAgent).not.toHaveBeenCalled();
  });

  it('a tool error mid-turn does not stop the reviewer (no final reply is lost)', async () => {
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'list_dir', args: { path: '/nonexistent-fraktole-xyz' } }] },
      { text: 'dir not found — moving on', toolCalls: [] },
    ]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctx,
      createProvider: () => provider,
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await host.start();
    await host.prompt('check the job');
    await settle(80);
    expect(provider.complete).toHaveBeenCalledTimes(2);
    const tools = host.conversation.filter((e) => e.role === 'tool');
    expect(tools.some((t) => String(t.content).startsWith('error:'))).toBe(true);
    expect(host.conversation.some((e) => e.role === 'assistant' && e.content === 'dir not found — moving on')).toBe(true);
    expect(host.status).toBe('running');
  });

  it('kill_agent refuses the orchestrator and unknown agents', async () => {
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'kill_agent', args: { agentId: 'orchestrator' } }, { id: 'c2', name: 'kill_agent', args: { agentId: 'ghost' } }] },
      { text: 'done', toolCalls: [] },
    ]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctx,
      createProvider: () => provider,
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await host.start();
    void host.prompt('kill guards');
    await settle(120);
    expect(ctx.killAgent).not.toHaveBeenCalled();
    expect(host.conversation.some((e) => e.content.includes('orchestrator is not an agent tile'))).toBe(true);
    expect(host.conversation.some((e) => e.content.includes('unknown agent ghost'))).toBe(true);
  });

  it('/kill (killAgentNow) kills directly without a grant and refuses the orchestrator', async () => {
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctx,
      createProvider: () => new FakeProvider([]),
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await host.start();
    expect(await host.killAgentNow('agent-1')).toBe('killed tile-1');
    expect(ctx.killAgent).toHaveBeenCalledWith('tile-1');
    expect(await host.killAgentNow('orchestrator')).toContain('not an agent tile');
    expect(await host.killAgentNow('ghost')).toContain('unknown agent');
  });

  it('spawn_agent with an explicit kind fires directly and remembers the kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-reviewer-'));
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'spawn_agent', args: { kind: 'opencode' } }] },
      { text: 'spawned ok', toolCalls: [] },
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
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await host.start();
    await host.prompt('spin one up');
    await settle(100);
    expect(ctx.spawnAgent).toHaveBeenCalledWith('opencode', '', { userPicked: false });
    expect(host.conversation.some((e) => e.content.includes('spawned agent a-9'))).toBe(true);
    const state = JSON.parse(await readFile(join(dir, 'reviewer', 'state.json'), 'utf8')) as ReviewerState;
    expect(state.lastAgentKind).toBe('opencode');
  });

  it('spawn_agent without a kind asks the user and persists the choice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-reviewer-'));
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'spawn_agent', args: {} }] },
      { text: 'user picked', toolCalls: [] },
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
      emit: {
        status: () => undefined,
        stream: () => undefined,
        toolCall: () => undefined,
        message: () => undefined,
        goal: () => undefined,
        question: (ev) => {
          if (ev.kind === 'agent-kind') host.answerQuestion(ev.askId, 'opencode');
        },
        usage: () => undefined,
      },
    });
    await host.start();
    await host.prompt('spin one up');
    await settle(100);
    expect(ctx.spawnAgent).toHaveBeenCalledWith('opencode', '', { userPicked: true });
    expect(host.conversation.some((e) => e.content.includes('spawned agent a-9'))).toBe(true);
    const state = JSON.parse(await readFile(join(dir, 'reviewer', 'state.json'), 'utf8')) as ReviewerState;
    expect(state.lastAgentKind).toBe('opencode');
  });

  it('spawn_agent refuses at the 8-agent cap', async () => {
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder, { agentCount: vi.fn(() => 8) as never });
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'spawn_agent', args: { kind: 'opencode' } }] },
      { text: 'refused', toolCalls: [] },
    ]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctx,
      createProvider: () => provider,
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await host.start();
    await host.prompt('spin one up');
    await settle(100);
    expect(ctx.spawnAgent).not.toHaveBeenCalled();
    expect(host.conversation.some((e) => e.content.includes('agent cap (8) reached'))).toBe(true);
  });

  it('set_goal from the model re-arms the loop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-reviewer-'));
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'set_goal', args: { text: 'finish the report' } }] },
      { text: 'goal engaged', toolCalls: [] },
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
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await host.start();
    await host.prompt('set a goal');
    await settle(150);
    const state = JSON.parse(await readFile(join(dir, 'reviewer', 'state.json'), 'utf8')) as ReviewerState;
    expect(state.goal?.text).toBe('finish the report');
    expect(state.goal?.state).toBe('active');
    expect(host.conversation.some((e) => e.content === 'goal engaged')).toBe(true);
    // the queued [goal armed] turn wakes the loop again
    expect(host.conversation.some((e) => e.content.includes('[goal armed] finish the report'))).toBe(true);
  });

  it('the status event carries the resolved model', async () => {
    const recorder = new TileRecorder();
    const models: Array<string | undefined> = [];
    const provider = new FakeProvider([{ text: 'ok', toolCalls: [] }]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ apiKey: 'sk-ant-api03-test' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctxFor(recorder),
      createProvider: () => provider,
      emit: {
        status: (_s, _e, model) => models.push(model),
        stream: () => undefined,
        toolCall: () => undefined,
        message: () => undefined,
        goal: () => undefined,
        question: () => undefined,
      usage: () => undefined,
      },
    });
    await host.start();
    expect(models).toContain('claude-sonnet-4-5');
  });

  it('streams thinking deltas and persists the assistant thinking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-reviewer-'));
    const recorder = new TileRecorder();
    const streams: Array<{ delta: string; thinking?: string }> = [];
    const provider = new FakeProvider([
      { text: 'the answer', toolCalls: [], thinking: 'deep reasoning here' },
    ]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: dir,
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctxFor(recorder),
      createProvider: () => provider,
      conversationFile: join(dir, 'conversation.jsonl'),
      emit: {
        status: () => undefined,
        stream: (ev) => streams.push(ev),
        toolCall: () => undefined,
        message: () => undefined,
        goal: () => undefined,
        question: () => undefined,
      usage: () => undefined,
      },
    });
    await host.start();
    await host.prompt('think hard');
    await settle(100);
    // the assistant entry carries the thinking
    const assistant = host.conversation.find((e) => e.role === 'assistant');
    expect(assistant?.thinking).toBe('deep reasoning here');
    // the persisted JSONL round-trips it
    const raw = await readFile(join(dir, 'conversation.jsonl'), 'utf8');
    expect(raw).toContain('deep reasoning here');
    const reloaded = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: dir,
      cwd: '/tmp/proj',
      recorder: new TileRecorder(),
      toolContext: ctxFor(recorder),
      createProvider: () => new FakeProvider([{ text: 'x', toolCalls: [] }]),
      conversationFile: join(dir, 'conversation.jsonl'),
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await reloaded.start();
    expect(reloaded.conversation.find((e) => e.role === 'assistant')?.thinking).toBe('deep reasoning here');
  });

  it('the test-tab tools route through the context', async () => {
    const recorder = new TileRecorder();
    const opened: string[] = [];
    const ctx = ctxFor(recorder, {
      openTestPage: vi.fn(async (url: string) => {
        opened.push(url);
        return `opened ${url} in the Test tab`;
      }) as never,
      readTestPage: vi.fn(async () => '{"url":"http://localhost:3000","title":"App","loading":false,"consoleErrors":2}') as never,
      screenshotTestPage: vi.fn(async () => 'saved /tmp/shot.png (1200 bytes)') as never,
    });
    const provider = new FakeProvider([
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'open_test_page', args: { url: 'http://localhost:5173' } },
          { id: 'c2', name: 'read_test_page', args: {} },
          { id: 'c3', name: 'screenshot_test_page', args: {} },
        ],
      },
      { text: 'tested ok', toolCalls: [] },
    ]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctx,
      createProvider: () => provider,
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await host.start();
    await host.prompt('test the app');
    await settle(120);
    expect(opened).toEqual(['http://localhost:5173']);
    const contents = host.conversation.map((e) => e.content);
    expect(contents.some((c) => c.includes('opened http://localhost:5173 in the Test tab'))).toBe(true);
    expect(contents.some((c) => c.includes('"consoleErrors":2'))).toBe(true);
    expect(contents.some((c) => c.includes('saved /tmp/shot.png'))).toBe(true);
  });

  it('open_test_page without a url errors cleanly', async () => {
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder, { openTestPage: vi.fn() as never });
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'open_test_page', args: {} }] },
      { text: 'nope', toolCalls: [] },
    ]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctx,
      createProvider: () => provider,
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await host.start();
    await host.prompt('open');
    await settle(100);
    expect(ctx.openTestPage).not.toHaveBeenCalled();
    expect(host.conversation.some((e) => e.content.includes('url required'))).toBe(true);
  });

  it('the new tool families route through the context', async () => {
    const recorder = new TileRecorder();
    const written: string[] = [];
    const ctx = ctxFor(recorder, {
      listMessages: vi.fn(async () => [
        { id: 'm1', from: 'orchestrator', to: 'agent-1', kind: 'task', body: 'go', at: 1 },
        { id: 'm2', from: 'agent-1', to: 'orchestrator', kind: 'result', body: 'done', at: 2 },
      ]) as never,
      writeToAgent: vi.fn(async (agentId: string, command: string) => {
        written.push(`${agentId}:${command}`);
        return `launched "${command}" in ${agentId}`;
      }) as never,
      reloadTestPage: vi.fn(async () => 'reload sent to the Test tab') as never,
    });
    const provider = new FakeProvider([
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'list_messages', args: { kind: 'task' } },
          { id: 'c2', name: 'launch_agent', args: { agentId: 'agent-1', command: 'opencode' } },
          { id: 'c3', name: 'reload_test_page', args: {} },
        ],
      },
      { text: 'all routed', toolCalls: [] },
    ]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'ollama', model: 'm' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctx,
      createProvider: () => provider,
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await host.start();
    await host.prompt('run everything');
    await settle(200);
    const contents = host.conversation.map((e) => e.content);
    expect(contents.some((c) => c.includes('"kind": "task"'))).toBe(true);
    expect(contents.some((c) => c.includes('"kind": "result"'))).toBe(false); // kind filter
    expect(written).toEqual(['agent-1:opencode']);
    expect(contents.some((c) => c.includes('reload sent to the Test tab'))).toBe(true);
  });

  it('passes an explicit reasoningEffort through to the provider', async () => {
    const recorder = new TileRecorder();
    const provider = new FakeProvider([{ text: 'ok', toolCalls: [] }]);
    const host = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ provider: 'openai', model: 'm', reasoningEffort: 'medium' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctxFor(recorder),
      createProvider: () => provider,
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await host.start();
    await host.prompt('x');
    await settle(60);
    const call = provider.complete.mock.calls[0]![0] as { reasoningEffort?: string };
    expect(call.reasoningEffort).toBe('medium');
  });

  it('defaults to high effort on official deepseek and omits it on custom endpoints', async () => {
    const recorder = new TileRecorder();
    const deepseek = new FakeProvider([{ text: 'ok', toolCalls: [] }]);
    const hostDs = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ apiKey: 'sk-ds-1', provider: 'deepseek' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctxFor(recorder),
      createProvider: () => deepseek,
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await hostDs.start();
    await hostDs.prompt('x');
    await settle(60);
    const call1 = deepseek.complete.mock.calls[0]![0] as { reasoningEffort?: string };
    expect(call1.reasoningEffort).toBe('high');

    const custom = new FakeProvider([{ text: 'ok', toolCalls: [] }]);
    const hostCustom = new ReviewerHost({
      getConfig: async (): Promise<ReviewerConfig> => ({ apiKey: 'sk-kimi-1', baseUrl: 'https://api.moonshot.cn/v1' }),
      sessionId: 's1',
      sessionDir: '/tmp/sessions/s1',
      cwd: '/tmp/proj',
      recorder,
      toolContext: ctxFor(recorder),
      createProvider: () => custom,
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined, usage: () => undefined },
    });
    await hostCustom.start();
    await hostCustom.prompt('x');
    await settle(60);
    const call2 = custom.complete.mock.calls[0]![0] as { reasoningEffort?: string };
    expect(call2.reasoningEffort).toBeUndefined();
  });

  it('stores a text-only assistant reply without an empty toolCalls key', async () => {
    const recorder = new TileRecorder();
    const { host } = makeHost([{ text: 'plain answer', toolCalls: [] }], recorder);
    await host.start();
    await host.prompt('q');
    await settle(60);
    const assistant = host.conversation.find((e) => e.role === 'assistant');
    expect(assistant?.content).toBe('plain answer');
    expect(assistant?.toolCalls).toBeUndefined();
  });

  it('prompt revives an idle reviewer and keeps the conversation', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'first', toolCalls: [] }, { text: 'second', toolCalls: [] }], recorder);
    await host.start();
    await host.prompt('one');
    await settle(60);
    host.idleOut();
    expect(host.status).toBe('idle');
    const accepted = await host.prompt('two');
    expect(accepted).toBe(true);
    await settle(60);
    expect(host.status).toBe('running');
    const texts = host.conversation.filter((e) => e.role === 'user').map((e) => e.content);
    expect(texts).toContain('two');
    expect(provider.complete.mock.calls.length).toBe(2);
  });

  it('prompt revives after a provider error, retaining context', async () => {
    const recorder = new TileRecorder();
    const { host } = makeHost([{ fail: true }, { fail: true }, { text: 'survive', toolCalls: [] }], recorder, { retryDelayMs: 1 });
    await host.start();
    await host.prompt('boom');
    await settle(80);
    expect(host.status).toBe('error');
    const accepted = await host.prompt('revive me');
    expect(accepted).toBe(true);
    await settle(60);
    expect(host.status).toBe('running');
    const users = host.conversation.filter((e) => e.role === 'user').map((e) => e.content);
    expect(users).toContain('revive me');
    expect(users).toContain('boom');
  });

  it('prompt refuses when the reviewer is explicitly stopped', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder);
    await host.start();
    host.stop();
    await expect(host.prompt('nope')).resolves.toBe(false);
    expect(provider.complete.mock.calls.length).toBe(0);
  });

  it('run retries a failed provider call once, then errors', async () => {
    const recorder = new TileRecorder();
    const { host, provider, events } = makeHost([{ fail: true }, { fail: true }], recorder, { retryDelayMs: 1 });
    await host.start();
    await host.prompt('q');
    await settle(80);
    expect(provider.complete.mock.calls.length).toBe(2);
    expect(host.status).toBe('error');
    expect(events).toContain('status:error');
  });

  it('run recovers when the retry succeeds', async () => {
    const recorder = new TileRecorder();
    const { host, provider, events } = makeHost([{ fail: true }, { text: 'recovered', toolCalls: [] }], recorder, { retryDelayMs: 1 });
    await host.start();
    await host.prompt('q');
    await settle(80);
    expect(provider.complete.mock.calls.length).toBe(2);
    expect(host.status).toBe('running');
    expect(events).not.toContain('status:error');
    expect(host.conversation.some((e) => e.role === 'assistant' && e.content === 'recovered')).toBe(true);
  });

  it('setGoal revives an idle reviewer instead of vanishing', async () => {
    const recorder = new TileRecorder();
    const { host } = makeHost([{ text: 'ok', toolCalls: [] }], recorder);
    await host.start();
    host.idleOut();
    await host.setGoal('watch this');
    await settle(60);
    expect(host.status).toBe('running');
    expect(host.conversation.some((e) => e.content.includes('watch this'))).toBe(true);
  });

  it('loads legacy poisoned history (empty toolCalls) without leaking it to the provider', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-poison-${process.pid}-${++hostSeq}`);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    // exactly the shape the old build persisted: assistant replies carrying
    // "toolCalls": []
    const poison = [
      { role: 'user', content: 'do you see the agents' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'list_tiles', args: {} }] },
      { role: 'tool', content: '[{"tileId":"tile-1"}]', toolCallId: 'c1' },
      { role: 'assistant', content: 'yes both agents are up', toolCalls: [] },
      { role: 'user', content: 'next' },
    ];
    await writeFile(join(dir, 'conversation.jsonl'), poison.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, { dir });
    await host.start();
    await host.prompt('first message');
    await settle(60);
    expect(host.status).toBe('running');
    const sent = provider.complete.mock.calls[0]![0] as { messages: ProviderMsg[] };
    const dirty = sent.messages.filter((m) => m.toolCalls !== undefined && m.toolCalls.length === 0);
    expect(dirty).toEqual([]);
    // the repaired history is preserved: the real tool turn survives
    expect(sent.messages.some((m) => m.role === 'assistant' && (m.toolCalls ?? []).length === 1)).toBe(true);
  });

  it('persists every tool result of a multi-call turn (no lossy tail)', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-multicall-${process.pid}-${++hostSeq}`);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const recorder = new TileRecorder();
    const { host } = makeHost(
      [
        { text: '', toolCalls: [{ id: 'a', name: 'list_dir', args: { path: '/tmp' } }, { id: 'b', name: 'search_files', args: { pattern: 'x' } }] },
      ],
      recorder,
      { dir },
    );
    await host.start();
    await host.prompt('go');
    await settle(80);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(dir, 'conversation.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as ProviderMsg);
    const toolLines = lines.filter((l) => l.role === 'tool');
    expect(toolLines.length).toBe(2);
    expect(toolLines.map((t) => t.toolCallId)).toEqual(['a', 'b']);
  });

  it('repairs an incomplete tool-call turn on load (crash-lost responses)', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-repair-${process.pid}-${++hostSeq}`);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    // assistant demanded three tools but only one response made it to disk
    const broken = [
      { role: 'user', content: 'launch agents' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a1', name: 'list_tiles', args: {} },
          { id: 'a2', name: 'spawn_agent', args: { kind: 'opencode' } },
          { id: 'a3', name: 'send_message', args: { to: 'agent-1' } },
        ],
      },
      { role: 'tool', content: 'done', toolCallId: 'a3' },
      { role: 'user', content: 'next turn' },
    ];
    await writeFile(join(dir, 'conversation.jsonl'), broken.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, { dir });
    await host.start();
    await host.prompt('first message');
    await settle(60);
    const sent = provider.complete.mock.calls[0]![0] as { messages: ProviderMsg[] };
    const roles = sent.messages.map((m) => m.role);
    expect(roles).not.toContain('tool');
    const assistants = sent.messages.filter((m) => m.role === 'assistant');
    expect(assistants.every((a) => (a.toolCalls ?? []).length === 0)).toBe(true);
    expect(sent.messages.map((m) => m.content)).toContain('first message');
  });

  it('compaction never orphans tool messages (the aggressive-compaction 400)', async () => {
    const recorder = new TileRecorder();
    // a small token budget forces aggressive compaction on every turn
    const { host, provider } = makeHost(
      [
        { text: '', toolCalls: [{ id: 'a1', name: 'list_tiles', args: {} }, { id: 'a2', name: 'spawn_agent', args: { kind: 'opencode' } }, { id: 'a3', name: 'send_message', args: { to: 'agent-1' } }] },
        { text: 'turn two reply', toolCalls: [] },
        { text: 'turn three reply', toolCalls: [] },
        { text: 'final reply', toolCalls: [] },
      ],
      recorder,
      { contextBudgetTokens: 4 },
    );
    await host.start();
    await host.prompt('launch agents');
    await settle(80);
    await host.prompt('second');
    await settle(80);
    await host.prompt('third');
    await settle(80);
    const sent = provider.complete.mock.calls[provider.complete.mock.calls.length - 1]![0] as { messages: ProviderMsg[] };
    const msgs = sent.messages;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      if (m.role === 'tool') {
        // scan back past any tool chain to the owning assistant
        let p = i - 1;
        while (p >= 0 && msgs[p]!.role === 'tool') p -= 1;
        const owner = p >= 0 ? msgs[p] : null;
        expect(owner?.role, `orphan tool at ${i}`).toBe('assistant');
        expect((owner as ProviderMsg).toolCalls?.some((c) => c.id === m.toolCallId), `tool ${m.toolCallId} has no owner call`).toBe(true);
      }
      if (m.role === 'assistant' && (m.toolCalls ?? []).length > 0) {
        const ids = (m.toolCalls ?? []).map((c) => c.id);
        const covered = new Set<string>();
        let j = i + 1;
        while (j < msgs.length && msgs[j]!.role === 'tool') {
          if (msgs[j]!.toolCallId) covered.add(msgs[j]!.toolCallId!);
          j += 1;
        }
        expect(ids.every((id) => covered.has(id)), 'assistant tool_calls lack responses after compaction').toBe(true);
      }
    }
    expect(host.status).toBe('running');
  });

  it('compaction keeps the two newest turns and inserts a user-role note', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost(
      [
        { text: '', toolCalls: [{ id: 't1', name: 'list_tiles', args: {} }] },
        { text: 'two', toolCalls: [] },
        { text: 'three', toolCalls: [] },
        { text: 'four', toolCalls: [] },
      ],
      recorder,
      { contextBudgetTokens: 4 },
    );
    await host.start();
    for (const p of ['one', 'two', 'three', 'four']) {
      await host.prompt(p);
      await settle(60);
    }
    const sent = provider.complete.mock.calls[provider.complete.mock.calls.length - 1]![0] as { messages: ProviderMsg[] };
    const contents = sent.messages.map((m) => m.content);
    expect(contents).toContain('three');
    expect(contents).toContain('four');
    expect(contents.some((c) => c.includes('context compacted'))).toBe(true);
    const note = sent.messages.find((m) => typeof m.content === 'string' && m.content.includes('context compacted'));
    expect(note?.role).toBe('user');
  });

  it('/compact during an in-flight turn is deferred to the turn boundary', async () => {
    const recorder = new TileRecorder();
    // three completed turns first so the deferred forced compact has whole
    // turns to drop when it lands
    const { host, provider } = makeHost(
      [
        { text: 'one', toolCalls: [] },
        { text: 'two', toolCalls: [] },
        { text: 'three', toolCalls: [] },
        { hang: true },
        { text: 'done', toolCalls: [] },
      ],
      recorder,
    );
    await host.start();
    await host.prompt('one');
    await settle(50);
    await host.prompt('two');
    await settle(50);
    await host.prompt('three');
    await settle(50);
    const p = host.prompt('long turn');
    await settle(20);
    host.compact();
    await settle(20);
    // still mid-run: nothing may have been spliced
    const msgsBefore = (provider.complete.mock.calls[0]![0] as { messages: ProviderMsg[] }).messages;
    expect(msgsBefore.some((m) => (m.content ?? '').includes('context compacted'))).toBe(false);
    // abort the hang so the run ends; the deferred compact lands in finally
    host.cancel();
    await p.catch(() => undefined);
    await settle(60);
    expect(host.conversation.some((e) => (e.content ?? '').includes('context compacted'))).toBe(true);
    expect(host.status).toBe('running');
  });

  it('goal-armed compaction auto-wakes the loop without a user prompt', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost(
      [
        { text: '', toolCalls: [{ id: 'g1', name: 'list_tiles', args: {} }] },
        { text: 'wake', toolCalls: [] },
        { text: 'again', toolCalls: [] },
        { text: 'third', toolCalls: [] },
        { text: 'final', toolCalls: [] },
      ],
      recorder,
      { contextBudgetTokens: 4 },
    );
    await host.start();
    await host.setGoal('ship the thing');
    await settle(80);
    await host.prompt('keep going');
    await settle(60);
    await host.prompt('third');
    await settle(80);
    expect(host.status).toBe('running');
    // goal turn + 2 prompts + the automatic watchdog wake
    expect(provider.complete.mock.calls.length).toBeGreaterThanOrEqual(4);
    const last = provider.complete.mock.calls[provider.complete.mock.calls.length - 1]![0] as { messages: ProviderMsg[] };
    expect(last.messages.some((m) => (m.content ?? '').includes('context was compacted'))).toBe(true);
  });

  it('accumulates usage per turn, emits it, and persists it in state.json', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-usage-${process.pid}-${++hostSeq}`);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const recorder = new TileRecorder();
    const { host, provider, events } = makeHost(
      [
        { text: 'one', toolCalls: [], usage: { inputTokens: 100, cachedTokens: 40, outputTokens: 20 } },
        { text: 'two', toolCalls: [], usage: { inputTokens: 160, cachedTokens: 70, outputTokens: 30 } },
      ],
      recorder,
      { dir },
    );
    await host.start();
    await host.prompt('q1');
    await settle(60);
    await host.prompt('q2');
    await settle(60);
    expect(provider.complete.mock.calls.length).toBe(2);
    const usageEvents = events.filter((e) => e.startsWith('usage:'));
    expect(usageEvents).toEqual(['usage:100:40:20', 'usage:260:110:50']);
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(join(dir, 'reviewer', 'state.json'), 'utf8')) as ReviewerState;
    expect(raw.usage).toEqual({ inputTokens: 260, cachedTokens: 110, outputTokens: 50 });
  });

  it('repairs a window with an EXTRA tool response (the leaked-tool 400)', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-extratool-${process.pid}-${++hostSeq}`);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    // exactly the shape found in the live session: assistant has one call,
    // but a second, orphan tool response follows it
    const broken = [
      { role: 'user', content: 'check agent-3' },
      { role: 'assistant', content: 'Agent-3 is in Build mode', toolCalls: [{ id: 'a1', name: 'read_tile', args: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'a1' },
      { role: 'tool', content: 'error: timed out after 300s', toolCallId: 'orphan-extra' },
      { role: 'user', content: 'continue' },
    ];
    await writeFile(join(dir, 'conversation.jsonl'), broken.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, { dir });
    await host.start();
    await host.prompt('continue');
    await settle(60);
    const sent = provider.complete.mock.calls[0]![0] as { messages: ProviderMsg[] };
    const tools = sent.messages.filter((m) => m.role === 'tool');
    expect(tools).toEqual([]);
    const assistants = sent.messages.filter((m) => m.role === 'assistant');
    expect(assistants.every((a) => (a.toolCalls ?? []).length === 0)).toBe(true);
    expect(sent.messages.map((m) => m.content)).toContain('continue');
  });

  it('keeps exact tool windows intact on load (valid multi-call turns)', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-validwindows-${process.pid}-${++hostSeq}`);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const good = [
      { role: 'user', content: 'launch' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a1', name: 'list_tiles', args: {} }, { id: 'a2', name: 'spawn_agent', args: {} }] },
      { role: 'tool', content: 'one', toolCallId: 'a1' },
      { role: 'tool', content: 'two', toolCallId: 'a2' },
      { role: 'assistant', content: 'done', toolCalls: [] },
      { role: 'user', content: 'next' },
    ];
    await writeFile(join(dir, 'conversation.jsonl'), good.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, { dir });
    await host.start();
    await host.prompt('go on');
    await settle(60);
    const sent = provider.complete.mock.calls[0]![0] as { messages: ProviderMsg[] };
    const tools = sent.messages.filter((m) => m.role === 'tool');
    expect(tools.map((t) => t.toolCallId)).toEqual(['a1', 'a2']);
    const callers = sent.messages.filter((m) => m.role === 'assistant' && (m.toolCalls ?? []).length > 0);
    expect(callers).toHaveLength(1);
    expect(callers[0]!.toolCalls!.map((c) => c.id)).toEqual(['a1', 'a2']);
  });

  it('persists the newest turns even after aggressive compaction (no skipped writes)', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-desync-${process.pid}-${++hostSeq}`);
    const { mkdir, readFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const recorder = new TileRecorder();
    const { host } = makeHost(
      [
        { text: 'one', toolCalls: [] },
        { text: 'two', toolCalls: [] },
        { text: 'three', toolCalls: [] },
        { text: 'four', toolCalls: [] },
      ],
      recorder,
      { dir, contextBudgetTokens: 4 },
    );
    await host.start();
    for (const p of ['one', 'two', 'three', 'four']) {
      await host.prompt(p);
      await settle(50);
    }
    const raw = await readFile(join(dir, 'conversation.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as ProviderMsg);
    expect(lines.map((l) => l.content)).toContain('four');
    expect(lines.map((l) => l.content)).toContain('three');
  });

  it('persists the prompt sent right after loading a repaired conversation', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-loaddesync-${process.pid}-${++hostSeq}`);
    const { mkdir, writeFile, readFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const broken = [
      { role: 'user', content: 'old turn' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a1', name: 'read_tile', args: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'a1' },
      { role: 'tool', content: 'extra', toolCallId: 'x9' },
    ];
    await writeFile(join(dir, 'conversation.jsonl'), broken.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
    const recorder = new TileRecorder();
    const { host } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, { dir });
    await host.start();
    await host.prompt('after repair');
    await settle(60);
    const raw = await readFile(join(dir, 'conversation.jsonl'), 'utf8');
    expect(raw).toContain('after repair');
  });

  it('watchdog revives the harness after an error when a goal is armed', async () => {
    const recorder = new TileRecorder();
    // first an armed-goal turn succeeds, then two failures exhaust the retry
    const { host, provider } = makeHost([{ text: 'armed ok', toolCalls: [] }, { fail: true }, { fail: true }, { text: 'healed', toolCalls: [] }], recorder, { retryDelayMs: 1 });
    await host.start();
    await host.setGoal('keep the loop alive');
    await settle(80);
    await host.prompt('boom');
    await settle(80);
    expect(host.status).toBe('error');
    const callsBefore = provider.complete.mock.calls.length;
    // the next watchdog tick revives the harness and wakes the loop — no
    // user prompt involved
    host.pollNow();
    await settle(120);
    expect(host.status).toBe('running');
    expect(provider.complete.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(host.conversation.some((e) => (e.content ?? '').includes('[watchdog] re-check progress'))).toBe(true);
  });

  it('a stalled provider stream is aborted and retried, then surfaces as error', async () => {
    const recorder = new TileRecorder();
    const { host, provider, events } = makeHost([{ hang: true }, { hang: true }], recorder, { retryDelayMs: 1, stallTimeoutMs: 60 });
    await host.start();
    await host.prompt('slow stream');
    await settle(400);
    // two attempts, both stalled -> a clear error, not a silent hang
    expect(provider.complete.mock.calls.length).toBe(2);
    expect(host.status).toBe('error');
    expect(events.some((e) => e.startsWith('status-error:stream stalled'))).toBe(true);
  });

  it('a stalled attempt that succeeds on retry keeps the harness running', async () => {
    const recorder = new TileRecorder();
    const { host, provider, events } = makeHost([{ hang: true }, { text: 'recovered', toolCalls: [] }], recorder, { retryDelayMs: 1, stallTimeoutMs: 60 });
    await host.start();
    await host.prompt('slow stream');
    await settle(400);
    expect(provider.complete.mock.calls.length).toBe(2);
    expect(host.status).toBe('running');
    expect(events).not.toContain('status:error');
    expect(host.conversation.some((e) => e.role === 'assistant' && e.content === 'recovered')).toBe(true);
  });

  it('a prompt typed while a turn is running appears immediately and is not duplicated', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'first reply', toolCalls: [] }, { hang: true }], recorder);
    await host.start();
    await host.prompt('first');
    await settle(60);
    // the second prompt lands while the next turn is hanging mid-stream
    const p = host.prompt('typed mid-turn');
    await settle(40);
    const userRows = host.conversation.filter((e) => e.role === 'user' && e.content.includes('typed mid-turn'));
    expect(userRows.length).toBe(1); // visible at queue time
    host.cancel();
    await p.catch(() => undefined);
    await settle(60);
    const after = host.conversation.filter((e) => e.role === 'user' && e.content.includes('typed mid-turn'));
    expect(after.length).toBe(1); // never duplicated
    expect(provider.complete.mock.calls.length).toBe(2);
  });

  it('set_goal subdivides the current goal and GOAL-MET marks every sub-goal done', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-subgoals-${process.pid}-${++hostSeq}`);
    const { mkdir, readFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const recorder = new TileRecorder();
    const { host } = makeHost(
      [
        { text: 'armed', toolCalls: [] },
        { text: 'first check reply', toolCalls: [] },
        { text: 'GOAL-MET: all sub-goals done', toolCalls: [] },
      ],
      recorder,
      { dir },
    );
    await host.start();
    await host.setGoal('build the release');
    await host.setGoal(null, [
      { text: 'wire the API', done: false },
      { text: 'ship the mobile app', done: true },
    ]);
    await host.prompt('first check');
    await settle(60);
    // the state block reports sub-goal progress
    expect(host.conversation.some((e) => (e.content ?? '').includes('[sub-goals: 1/2 done]'))).toBe(true);
    const stateFile = join(dir, 'reviewer', 'state.json');
    let raw = JSON.parse(await readFile(stateFile, 'utf8')) as ReviewerState;
    expect(raw.subGoals.length).toBe(2);
    expect(raw.subGoals[1]!.state).toBe('done');
    // replacing the goal clears the subdivision
    await host.setGoal('a different goal');
    await settle(60);
    raw = JSON.parse(await readFile(stateFile, 'utf8')) as ReviewerState;
    expect(raw.subGoals).toEqual([]);
    // GOAL-MET flips every sub-goal to done
    await host.setGoal('build the release', [{ text: 'a', done: false }, { text: 'b', done: false }]);
    await host.prompt('finish it');
    await settle(100);
    raw = JSON.parse(await readFile(stateFile, 'utf8')) as ReviewerState;
    expect(raw.goal?.state).toBe('met');
    expect(raw.subGoals.every((s) => s.state === 'done')).toBe(true);
  });

  it('setVariant swaps the system prompt and persists the variant', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-variant-${process.pid}-${++hostSeq}`);
    const { mkdir, readFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const recorder = new TileRecorder();
    const { host } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, { dir });
    await host.start();
    await host.setVariant('cyber');
    await settle(30);
    const systemMsg = host.conversation[0];
    expect(systemMsg?.role).toBe('system');
    expect(systemMsg?.content).toContain('AUTONOMOUS MODE: CYBER');
    const raw = JSON.parse(await readFile(join(dir, 'reviewer', 'state.json'), 'utf8')) as ReviewerState;
    expect(raw.variant).toBe('cyber');
    // clearing restores the base prompt
    await host.setVariant(null);
    await settle(30);
    expect(host.conversation[0]?.content).not.toContain('AUTONOMOUS MODE');
  });

  it('persists the system prompt as line one and restores it verbatim on reload', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-syspersist-${process.pid}-${++hostSeq}`);
    const { mkdir, readFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const recorder = new TileRecorder();
    const { host } = makeHost(
      [{ text: 'ok', toolCalls: [] }, { text: 'ok', toolCalls: [] }],
      recorder,
      {
        dir,
        config: {
          provider: 'ollama',
          model: 'm',
          customAutonomy: { name: 'My Loop', prompt: 'AUTONOMOUS MODE: MY LOOP\n- my directive line' },
        },
      },
    );
    await host.start();
    await host.setVariant('custom');
    await host.prompt('hi');
    await settle(60);
    const lines = (await readFile(join(dir, 'conversation.jsonl'), 'utf8'))
      .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
    expect(lines[0]!.role).toBe('system');
    expect(lines[0]!.content).toContain('AUTONOMOUS MODE: MY LOOP');
    // a second host reloading the same session restores the SAME doctrine
    // verbatim — even though its config no longer carries the saved custom
    // prompt, so identity to the persisted line is the only way it can
    // contain MY LOOP (a rebuild would produce the CUSTOM placeholder)
    const { host: host2 } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, { dir });
    await host2.start();
    const mem = host2 as unknown as { messages: Array<{ role: string; content: string }> };
    expect(mem.messages[0]!.role).toBe('system');
    expect(mem.messages[0]!.content).toBe(lines[0]!.content);
    expect(mem.messages[0]!.content).toContain('my directive line');
  });

  it('setVariant rewrites the persisted system line so reloads see the new doctrine', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-variantpersist-${process.pid}-${++hostSeq}`);
    const { mkdir, readFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const recorder = new TileRecorder();
    const { host } = makeHost(
      [{ text: 'ok', toolCalls: [] }, { text: 'ok', toolCalls: [] }],
      recorder,
      { dir },
    );
    await host.start();
    await host.setVariant('feature');
    await settle(30);
    const lines = (await readFile(join(dir, 'conversation.jsonl'), 'utf8'))
      .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
    expect(lines[0]!.role).toBe('system');
    expect(lines[0]!.content).toContain('AUTONOMOUS MODE: FEATURES');
    // the swapped doctrine survives a restart without calling setVariant
    const { host: host2 } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, { dir });
    await host2.start();
    const mem = host2 as unknown as { messages: Array<{ role: string; content: string }> };
    expect(mem.messages[0]!.content).toContain('AUTONOMOUS MODE: FEATURES');
  });

  it('custom variant uses the saved directive and arms a name-derived mission', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-custom-${process.pid}-${++hostSeq}`);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const recorder = new TileRecorder();
    const { host } = makeHost(
      [{ text: 'ok', toolCalls: [] }],
      recorder,
      {
        dir,
        config: {
          provider: 'ollama',
          model: 'm',
          customAutonomy: { name: 'My Loop', prompt: 'AUTONOMOUS MODE: MY LOOP\n- my directive line' },
        },
      },
    );
    await host.start();
    await host.setVariant('custom');
    await settle(30);
    const systemMsg = host.conversation[0];
    expect(systemMsg?.content).toContain('AUTONOMOUS MODE: MY LOOP');
    expect(systemMsg?.content).toContain('my directive line');
    expect(systemMsg?.content).not.toContain('AUTONOMOUS MODE: CUSTOM');
    // startAutonomy forks under 'custom' and arms the name-derived mission
    (host as unknown as { opts: { forkProject?: (v: string) => Promise<{ ok: boolean; path?: string; error?: string }> } }).opts.forkProject = async (v: string) => ({
      ok: true,
      path: `/tmp/proj/.fraktole-auto/${v}`,
    });
    const res = await host.startAutonomy('custom');
    expect(res.ok).toBe(true);
    await settle(50);
    expect(host.conversation.some((e) => (e.content ?? '').includes('Autonomous custom run: My Loop'))).toBe(true);
    expect(host.conversation.some((e) => (e.content ?? '').includes('fork at /tmp/proj/.fraktole-auto/custom'))).toBe(true);
  });

  it('startAutonomy forks, arms the mission goal and kicks off the loop', async () => {
    const recorder = new TileRecorder();
    const forked: string[] = [];
    const { host, provider } = makeHost(
      [
        { text: 'armed ok', toolCalls: [] },
        { text: 'research round one', toolCalls: [] },
      ],
      recorder,
      { retryDelayMs: 1 },
    );
    (host as unknown as { opts: { forkProject?: (v: string) => Promise<{ ok: boolean; path?: string; error?: string }> } }).opts.forkProject = async (v: string) => {
      forked.push(v);
      return { ok: true, path: `/tmp/proj/.fraktole-auto/${v}` };
    };
    const res = await host.startAutonomy('cyber');
    expect(res.ok).toBe(true);
    expect(forked).toEqual(['cyber']);
    await settle(100);
    // the mission goal is armed and the kick-off turn is visible immediately
    expect(host.conversation.some((e) => (e.content ?? '').includes('[autonomous mode] variant=cyber'))).toBe(true);
    expect(host.conversation.some((e) => (e.content ?? '').includes('fork at /tmp/proj/.fraktole-auto/cyber'))).toBe(true);
    expect(provider.complete.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('startAutonomy surfaces a fork failure cleanly', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder);
    (host as unknown as { opts: { forkProject?: () => Promise<{ ok: boolean; error: string }> } }).opts.forkProject = async () => ({ ok: false, error: 'no project to fork (cwd is the home directory)' });
    const res = await host.startAutonomy('bugs');
    expect(res).toEqual({ ok: false, error: 'no project to fork (cwd is the home directory)' });
    expect(provider.complete.mock.calls.length).toBe(0);
  });

  it('autonomous mode auto-resolves ask_user without emitting question cards', async () => {
    const recorder = new TileRecorder();
    const { host, provider, events } = makeHost(
      [
        { text: '', toolCalls: [{ id: 'c1', name: 'ask_user', args: { question: 'which agent?', kind: 'agent-kind' } }] },
        { text: '', toolCalls: [{ id: 'c2', name: 'ask_user', args: { question: 'proceed?', kind: 'free' } }] },
        { text: 'auto', toolCalls: [] },
      ],
      recorder,
    );
    await host.start();
    await host.setVariant('frontend');
    await host.prompt('run autonomously');
    await settle(120);
    // both ask_user calls resolved instantly (no cards, no suspension)
    expect(provider.complete.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.startsWith('question:'))).toBe(false);
    expect(host.conversation.some((e) => e.role === 'assistant' && e.content === 'auto')).toBe(true);
  });

  it('an unanswered ask_user rejects after the ask timeout and the loop continues', async () => {
    const recorder = new TileRecorder();
    const { host, provider, asks } = makeHost(
      [
        { text: '', toolCalls: [{ id: 'c1', name: 'ask_user', args: { question: 'wait for timeout?', kind: 'free' } }] },
        { text: 'after timeout', toolCalls: [] },
      ],
      recorder,
      { askTimeoutMs: 40 },
    );
    await host.start();
    await host.prompt('ask');
    await settle(120);
    expect(asks).toHaveLength(1);
    // the promise should reject within ~1s
    await settle(80);
    // the loop should not be stuck — a subsequent queue item processes
    expect(provider.complete.mock.calls.length).toBeGreaterThanOrEqual(1);
    const contents = host.conversation.map((e) => e.content);
    expect(contents).toContain('after timeout');
    expect(provider.complete.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('answerQuestion after the timeout is a no-op', async () => {
    const recorder = new TileRecorder();
    const { host, provider, asks } = makeHost(
      [
        { text: '', toolCalls: [{ id: 'c1', name: 'ask_user', args: { question: 'q?', kind: 'free' } }] },
        { text: 'done', toolCalls: [] },
      ],
      recorder,
      { askTimeoutMs: 40 },
    );
    await host.start();
    await host.prompt('ask');
    await settle(120);
    expect(asks).toHaveLength(1);
    // wait for the timeout rejection
    await settle(80);
    // answerQuestion with the correct askId should be a no-op since pendingAsk was cleared
    host.answerQuestion(asks[0]!.id, 'ok');
    await settle(60);
    // the loop should have moved on (not stuck)
    expect(provider.complete.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  describe('auto compose: resume, summarize, stop', () => {
    async function seedFork(dir: string, variant: string): Promise<void> {
      await mkdir(join(dir, '.fraktole-auto', variant), { recursive: true });
      await writeFile(join(dir, '.fraktole-auto', variant, 'keep.txt'), 'work', 'utf8');
    }

    it('resumableRun reports true only for an active goal + existing fork', async () => {
      const dir = await mkdtemp(join(tmpdir(), `frak-resumable-${process.pid}-${++hostSeq}`));
      await seedFork(dir, 'feature');
      const recorder = new TileRecorder();
      const { host } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, { dir, cwd: dir });
      await host.start();
      await host.setGoal('mission');
      await settle(30);
      expect(await host.resumableRun('feature')).toEqual({ resumable: true, goalText: 'mission' });
      // existing fork but no active goal → not resumable
      await host.setGoal(null);
      await settle(30);
      expect((await host.resumableRun('feature')).resumable).toBe(false);
      // active goal but no fork → not resumable
      await host.setGoal('again');
      await settle(30);
      expect((await host.resumableRun('frontend')).resumable).toBe(false);
    });

    it('startAutonomy resumes in place: no re-fork, resume kick, goal kept', async () => {
      const dir = await mkdtemp(join(tmpdir(), `frak-resume2-${process.pid}-${++hostSeq}`));
      await seedFork(dir, 'feature');
      const recorder = new TileRecorder();
      const forkProject = vi.fn(async () => ({ ok: true as const, path: join(dir, '.fraktole-auto', 'feature') }));
      const { host } = makeHost(
        [{ text: 'goal armed', toolCalls: [] }, { text: 'continue run', toolCalls: [] }],
        recorder,
        { dir, cwd: dir, forkProject: forkProject as never },
      );
      await host.start();
      await host.setGoal('mission');
      await settle(40);
      const res = await host.startAutonomy('feature', 'auto');
      expect(res.ok).toBe(true);
      await settle(40);
      expect(forkProject).not.toHaveBeenCalled();
      expect(host.conversation.some((e) => (e.content ?? '').includes('resuming the previous run'))).toBe(true);
      // the goal was not re-armed: still 'mission' (no new [goal armed] turn)
      expect(host.conversation.filter((e) => (e.content ?? '').includes('[goal armed]'))).toHaveLength(1);
    });

    it('startAutonomy fresh forks (wipes), arms the mission and begins', async () => {
      const dir = await mkdtemp(join(tmpdir(), `frak-fresh-${process.pid}-${++hostSeq}`));
      await seedFork(dir, 'feature');
      const recorder = new TileRecorder();
      const forkProject = vi.fn(async () => ({ ok: true as const, path: join(dir, '.fraktole-auto', 'feature') }));
      const { host } = makeHost(
        [{ text: 'armed', toolCalls: [] }, { text: 'begin', toolCalls: [] }],
        recorder,
        { dir, cwd: dir, forkProject: forkProject as never },
      );
      await host.start();
      await host.startAutonomy('feature', 'auto'); // no goal → fresh
      await settle(40);
      expect(forkProject).toHaveBeenCalledWith('feature', false);
      expect(host.conversation.some((e) => (e.content ?? '').includes('Begin the loop'))).toBe(true);
    });

    it('startAutonomy mode fresh re-forks even with a resumable state', async () => {
      const dir = await mkdtemp(join(tmpdir(), `frak-freshmode-${process.pid}-${++hostSeq}`));
      await seedFork(dir, 'feature');
      const recorder = new TileRecorder();
      const forkProject = vi.fn(async () => ({ ok: true as const, path: join(dir, '.fraktole-auto', 'feature') }));
      const { host } = makeHost(
        [{ text: 'goal armed', toolCalls: [] }, { text: 'begin', toolCalls: [] }],
        recorder,
        { dir, cwd: dir, forkProject: forkProject as never },
      );
      await host.start();
      await host.setGoal('mission');
      await settle(40);
      await host.startAutonomy('feature', 'fresh');
      await settle(40);
      expect(forkProject).toHaveBeenCalledWith('feature', false);
      expect(host.conversation.some((e) => (e.content ?? '').includes('Begin the loop'))).toBe(true);
    });

    it('doStart pushes an immediate resume wake when a goal is armed on reload', async () => {
      const dir = await mkdtemp(join(tmpdir(), `frak-dostart-${process.pid}-${++hostSeq}`));
      await mkdir(join(dir, 'reviewer'), { recursive: true });
      await writeFile(
        join(dir, 'reviewer', 'state.json'),
        JSON.stringify({ goal: { text: 'persisted goal', setAt: 1, state: 'active' }, subGoals: [], tasks: [], lastAgentKind: null, variant: 'feature', usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }, recap: null }),
        'utf8',
      );
      const recorder = new TileRecorder();
      const { host } = makeHost([{ text: 'resumed', toolCalls: [] }], recorder, { dir });
      await host.start();
      await settle(40);
      expect(host.conversation.some((e) => (e.content ?? '').includes('[resume] continuing the autonomous run'))).toBe(true);
    });

    it('summarizeSession captures the recap, persists it and emits it', async () => {
      const dir = await mkdtemp(join(tmpdir(), `frak-summarize-${process.pid}-${++hostSeq}`));
      const recorder = new TileRecorder();
      const { host, events } = makeHost([{ text: 'work done', toolCalls: [] }, { text: 'RECAP: the goal is complete', toolCalls: [] }], recorder, { dir });
      await host.start();
      await host.prompt('do work');
      await settle(40);
      host.summarizeSession();
      await settle(60);
      const raw = JSON.parse(await readFile(join(dir, 'reviewer', 'state.json'), 'utf8'));
      expect(raw.recap.text).toContain('RECAP: the goal is complete');
      expect(events.some((e) => e.startsWith('recap:'))).toBe(true);
    });

    it('summarizeSession wipes the history into a big compact that keeps only the system prompt + recap', async () => {
      const dir = await mkdtemp(join(tmpdir(), `frak-bigcompact-${process.pid}-${++hostSeq}`));
      const recorder = new TileRecorder();
      const { host } = makeHost([
        { text: 'first work', toolCalls: [] },
        { text: 'second work', toolCalls: [] },
        { text: 'RECAP: everything is now one summary', toolCalls: [] },
      ], recorder, { dir });
      await host.start();
      await host.setGoal('keep the goal across the big compact');
      await settle(30);
      await host.prompt('do work');
      await settle(40);
      host.summarizeSession();
      await settle(80);
      // the conversation file is the system prompt + the big-compact summary
      // turn only. The system prompt is persisted (it is part of the
      // transcript) and restored verbatim on reload — the on-disk file holds
      // exactly [system, summary], all prior history wiped.
      const lines = (await readFile(join(dir, 'conversation.jsonl'), 'utf8'))
        .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
      expect(lines.length).toBe(2); // system line + big-compact summary
      expect(lines[0]!.role).toBe('system');
      expect(lines[1]!.role).toBe('user');
      expect(lines[1]!.content).toContain('[big compact]');
      expect(lines[1]!.content).toContain('RECAP: everything is now one summary');
      // the summary turn still carries the goal/ledger state block
      expect(lines[1]!.content).toContain('[goal');
      // and the in-memory conversation still holds the system prompt first
      const mem = host as unknown as { messages: Array<{ role: string; content: string }> };
      expect(mem.messages[0]!.role).toBe('system');
      expect(mem.messages.length).toBe(2); // [system, summary]
    });

    it('summarizeSession refuses when the reviewer is stopped', async () => {
      const dir = await mkdtemp(join(tmpdir(), `frak-sumstop-${process.pid}-${++hostSeq}`));
      const recorder = new TileRecorder();
      const { host } = makeHost([], recorder, { dir });
      await host.start();
      await host.stop();
      expect(host.summarizeSession().ok).toBe(false);
    });

    it('stop is a full stop: status stopped, queue cleared, watchdog cannot revive', async () => {
      const recorder = new TileRecorder();
      const { host } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, {});
      await host.start();
      await host.setGoal('keep');
      await settle(30);
      host.stop();
      expect(host.status).toBe('stopped');
      host.pollNow();
      await settle(40);
      expect(host.status).toBe('stopped');
      expect(host.conversation.some((e) => (e.content ?? '').includes('[watchdog]'))).toBe(false);
    });
  });

  describe('prompt pickup: preemptive yield', () => {
    it('yields the current turn to a queued user prompt at the tool boundary', async () => {
      const dir = await mkdtemp(join(tmpdir(), `frak-interrupt-${process.pid}-${++hostSeq}`));
      const recorder = recorderWith('line');
      // turn A's first complete is delayed so the interrupt lands mid-turn
      // (during the in-flight model call), before the second tool iteration
      const { host } = makeHost(
        [
          { text: '', toolCalls: [{ id: 'c1', name: 'read_tile', args: { tileId: 'tile-1' } }], delay: 120 },
          { text: '', toolCalls: [{ id: 'c2', name: 'read_tile', args: { tileId: 'tile-1' } }] },
          { text: 'done', toolCalls: [] },
        ],
        recorder,
        { dir },
      );
      await host.start();
      await host.prompt('work'); // turn A starts; its first complete() is delayed
      await settle(30); // let turn A pass setup and enter the in-flight complete()
      host.prompt('interrupt'); // queued mid-turn → pendingInterrupt
      await settle(120); // delayed complete resolves, tool runs, next boundary breaks
      // the interrupt was processed
      expect(host.conversation.some((e) => (e.content ?? '') === 'interrupt')).toBe(true);
      // turn A yielded after ONE iteration: the 'interrupt' user turn follows
      // turn A's first tool result directly, and turn A never issued a second
      // tool call (c2) before it
      const idx = host.conversation.findIndex((e) => (e.content ?? '') === 'interrupt');
      expect(idx).toBeGreaterThan(-1);
      const before = host.conversation.slice(0, idx);
      expect(before.filter((e) => e.role === 'assistant')).toHaveLength(1);
      expect(before.some((e) => e.toolCallId === 'c1')).toBe(true);
      expect(before.some((e) => e.toolCallId === 'c2')).toBe(false);
    });
  });

  describe('result preemption', () => {
    function resultMsg(body: string, kind: FraktoleMessage['kind'] = 'result'): FraktoleMessage {
      return { id: `m-${Math.random()}`, from: 'agent-27', to: 'orchestrator', kind, body, at: Date.now() };
    }

    it('a task result yields the current turn at the tool boundary', async () => {
      const dir = await mkdtemp(join(tmpdir(), `frak-resinterrupt-${process.pid}-${++hostSeq}`));
      const recorder = recorderWith('line');
      const { host } = makeHost(
        [
          { text: '', toolCalls: [{ id: 'c1', name: 'read_tile', args: { tileId: 'tile-1' } }], delay: 120 },
          { text: '', toolCalls: [{ id: 'c2', name: 'read_tile', args: { tileId: 'tile-1' } }] },
          { text: 'done', toolCalls: [] },
        ],
        recorder,
        { dir },
      );
      await host.start();
      await host.prompt('work'); // turn A starts; its first complete() is delayed
      await settle(30); // enter the in-flight complete()
      await host.onAgentMessage(resultMsg('verified')); // result queued mid-turn → pendingInterrupt
      await settle(120); // delayed complete resolves, tool runs, next boundary breaks
      const idx = host.conversation.findIndex((e) => (e.content ?? '').includes('(result)]: verified'));
      expect(idx).toBeGreaterThan(-1);
      const before = host.conversation.slice(0, idx);
      // turn A yielded after ONE iteration: only c1, never c2
      expect(before.filter((e) => e.role === 'assistant')).toHaveLength(1);
      expect(before.some((e) => e.toolCallId === 'c1')).toBe(true);
      expect(before.some((e) => e.toolCallId === 'c2')).toBe(false);
    });

    it('a note does NOT yield the current turn (stays FIFO)', async () => {
      const dir = await mkdtemp(join(tmpdir(), `frak-note-${process.pid}-${++hostSeq}`));
      const recorder = recorderWith('line');
      const { host } = makeHost(
        [
          { text: '', toolCalls: [{ id: 'c1', name: 'read_tile', args: { tileId: 'tile-1' } }], delay: 120 },
          { text: '', toolCalls: [{ id: 'c2', name: 'read_tile', args: { tileId: 'tile-1' } }] },
          { text: 'done', toolCalls: [] },
        ],
        recorder,
        { dir },
      );
      await host.start();
      await host.prompt('work'); // turn A starts
      await settle(30); // enter the in-flight complete()
      await host.onAgentMessage(resultMsg('heads up', 'note')); // note → NO preempt
      await settle(250); // turn A runs to completion (c1, c2, done), then the note
      const idx = host.conversation.findIndex((e) => (e.content ?? '').includes('(note)]: heads up'));
      expect(idx).toBeGreaterThan(-1);
      const before = host.conversation.slice(0, idx);
      // turn A ran to full completion (c1, c2, and its final answer) before
      // the note was processed — the note did NOT preempt
      expect(before.filter((e) => e.role === 'assistant')).toHaveLength(3);
      expect(before.some((e) => e.toolCallId === 'c1')).toBe(true);
      expect(before.some((e) => e.toolCallId === 'c2')).toBe(true);
    });
  });
});

describe('ReviewerHost — local-provider hardening (context, truncation, readiness, stall guard)', () => {
  const llamacppConfig: ReviewerConfig = { providerId: 'llamacpp', model: 'local-model', baseUrl: 'http://localhost:8080/v1' };
  const okProbe = (contextTokens = 16_384): (() => Promise<unknown>) =>
    vi.fn(async () => ({ contextTokens, state: 'ok', kind: 'llamacpp' })) as never;

  it('a fresh-first-run (nothing configured) asks to pick a provider instead of silently targeting ollama', async () => {
    const recorder = new TileRecorder();
    const { host, events } = makeHost([], recorder, { config: {} });
    expect(await host.start()).toBe(false);
    expect(host.status).toBe('unconfigured');
    expect(events.some((e) => e.startsWith('status-error:') && e.includes('pick a provider'))).toBe(true);
  });

  it('resolved budget honors the probed server window (knob capped by probe)', async () => {
    const recorder = new TileRecorder();
    const { host, events, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, {
      config: { ...llamacppConfig, knobs: { contextTokens: 4096 } },
      probe: okProbe(2048),
    });
    await host.start();
    await host.prompt('x');
    await settle(60);
    expect(events).toContain('budget:2048');
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('a context-overflow 400 compacts the conversation and retries (never dies)', async () => {
    const recorder = new TileRecorder();
    const { host, provider, events } = makeHost(
      [
        { failWith: 'openai API error 400: input exceeds the available context window (n_ctx 1000)' },
        { text: 'recovered', toolCalls: [] },
      ],
      recorder,
      { config: llamacppConfig, probe: okProbe() },
    );
    await host.start();
    await host.prompt('big turn');
    await settle(120);
    expect(host.status).toBe('running');
    expect(provider.complete).toHaveBeenCalledTimes(2);
    // the compaction dropped everything but the newest turn — and the
    // conversation still contains the model's recovery reply
    expect(host.conversation.some((e) => e.content.includes('recovered'))).toBe(true);
    expect(events.some((e) => e.startsWith('status-error:'))).toBe(false);
  });

  it('max_tokens is clipped to the remaining window (prompt + output can never overrun the server context)', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost([{ text: 'ok', toolCalls: [] }], recorder, {
      config: { ...llamacppConfig, knobs: { contextTokens: 1000, maxOutputTokens: 4096 } },
      probe: okProbe(1_000_000),
    });
    await host.start();
    await host.prompt('x');
    await settle(60);
    const knobs = (provider.complete.mock.calls[0]![0] as { knobs: { maxOutputTokens: number } }).knobs;
    // budget 1000 - system estimate 400 - reserve 512 → floor 256
    expect(knobs.maxOutputTokens).toBe(256);
  });

  it('a length-truncated reply (no tool calls) triggers a bounded continue prompt instead of a silent stop', async () => {
    const recorder = new TileRecorder();
    const { host, provider } = makeHost(
      [
        { text: 'The reply was cut', toolCalls: [], finishReason: 'length' },
        { text: 'continuing where I left off', toolCalls: [] },
      ],
      recorder,
      { config: llamacppConfig, probe: okProbe() },
    );
    await host.start();
    await host.prompt('x');
    await settle(120);
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(host.conversation.some((e) => e.content.includes('cut off at the provider'))).toBe(true);
    expect(host.conversation.some((e) => e.content.includes('continuing where I left off'))).toBe(true);
  });

  it('a length-truncated tool call is NEVER executed: the window closes with an error and the loop continues', async () => {
    const recorder = new TileRecorder();
    const { host, events } = makeHost(
      [
        { text: '', toolCalls: [{ id: 'c1', name: 'read_tile', args: { _raw: '{"agentId":unclosed' } }], finishReason: 'length' },
        { text: 're-issued correctly', toolCalls: [] },
      ],
      recorder,
      { config: llamacppConfig, probe: okProbe() },
    );
    await host.start();
    await host.prompt('x');
    await settle(120);
    expect(events).toContain('tool:read_tile:error');
    expect(host.conversation.some((e) => e.role === 'tool' && (e.content ?? '').includes('truncated by the provider'))).toBe(true);
    expect(host.conversation.some((e) => e.content.includes('re-issued correctly'))).toBe(true);
  });

  it('a still-loading server (503 Loading model) is waited out, not errored', async () => {
    const recorder = new TileRecorder();
    const { host, provider, events } = makeHost(
      [
        { failWith: 'openai API error 503: Loading model' },
        { text: 'loaded at last', toolCalls: [] },
      ],
      recorder,
      { config: llamacppConfig, probe: okProbe(), loadingRetryMs: 1 },
    );
    await host.start();
    await host.prompt('x');
    await settle(200);
    expect(host.status).toBe('running');
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.startsWith('status-error:'))).toBe(false);
    // and 503s are retried rather than marked fatal only up to the loading cap
    const recorder2 = new TileRecorder();
    const { host: host2, events: events2 } = makeHost(
      [{ failWith: 'openai API error 503: Loading model' }],
      recorder2,
      { config: llamacppConfig, probe: okProbe(), loadingRetryMs: 1 },
    );
    await host2.start();
    await host2.prompt('x');
    await settle(120);
    expect(host2.status).toBe('error');
    expect(events2.filter((e) => e.startsWith('status-error:')).length).toBeGreaterThan(0);
  });

  it('a crashed/silent local server surfaces a durable error and reappears on restart', async () => {
    const dir = join(tmpdir(), `fraktole-reviewer-local-death-${process.pid}-${++hostSeq}`);
    const recorder = new TileRecorder();
    const { host, events } = makeHost([{ failWith: 'openai API error 404: model not found' }], recorder, {
      config: llamacppConfig,
      probe: okProbe(),
      dir,
    });
    await host.start();
    await host.prompt('x');
    await settle(80);
    expect(host.status).toBe('error');
    expect(events.some((e) => e.startsWith('status-error:'))).toBe(true);
    const state = JSON.parse(await readFile(join(dir, 'reviewer', 'state.json'), 'utf8')) as { lastError?: string };
    expect(state.lastError).toMatch(/404/);
    // a fresh host on the same dir resurfaces the failure at start
    const recorder2 = new TileRecorder();
    const { host: host2, events: events2 } = makeHost([], recorder2, {
      config: llamacppConfig,
      probe: okProbe(),
      dir,
    });
    await host2.start();
    expect(events2.some((e) => e.startsWith('prevError:') && e.includes('404'))).toBe(true);
  });

  it('three ledger-less watchdog re-checks stand the re-check loop down (the stall guard)', async () => {
    const recorder = new TileRecorder();
    // 1 goal-armed turn + 3 re-checks + 1 stall-warning turn
    const script: ScriptEntry[] = Array.from({ length: 5 }, () => ({ text: 'still nothing', toolCalls: [] }));
    const { host, provider } = makeHost(script, recorder, {
      config: llamacppConfig,
      probe: okProbe(),
      retryDelayMs: 1,
    });
    await host.start();
    await host.setGoal('do the thing'); // queues "[goal armed]" turn
    await settle(120); // goal-armed turn completes (drained)
    expect(host.status).toBe('running');
    let guard = 0;
    for (; provider.complete.mock.calls.length < 5 && guard < 60; guard += 1) {
      host.pollNow();
      await settle(30);
    }
    // the 6-poll backstop needs its own ticks for each wake
    for (let i = 0; i < 6; i++) {
      host.pollNow();
      await settle(30);
    }
    await settle(200);
    expect(provider.complete).toHaveBeenCalledTimes(5);
    expect(host.conversation.some((e) => e.content.includes('[stall warning]'))).toBe(true);
    // beyond the limit, no more wakes append context
    const calls = provider.complete.mock.calls.length;
    for (let i = 0; i < 8; i++) {
      host.pollNow();
      await settle(30);
    }
    await settle(200);
    // the warning turn consumed one — count grows only if the guard broke
    expect(provider.complete.mock.calls.length).toBe(calls);
  });
});
