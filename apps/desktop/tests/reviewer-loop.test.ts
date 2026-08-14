import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewerHost, type ReviewerConfig } from '../electron/reviewer.js';
import type { ReviewerToolContext } from '../electron/reviewer-tools.js';
import type { ReviewerState } from '../src/shared/ipc.js';
import { TileRecorder } from '../electron/tile-recorder.js';
import type { ProviderClient, ProviderMsg } from '../electron/reviewer/providers.js';

type ScriptEntry =
  | { text: string; toolCalls: ProviderMsg['toolCalls']; thinking?: string; usage?: { inputTokens: number; cachedTokens: number; outputTokens: number } }
  | { hang: boolean }
  | { fail: boolean };

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
      return Promise.resolve({
        text: entry.text,
        toolCalls: entry.toolCalls ?? [],
        thinking: entry.thinking ?? '',
        ...(entry.usage ? { usage: entry.usage } : {}),
      });
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
    killAgent: vi.fn(async () => 'killed tile-1') as never,
    spawnAgent: vi.fn(async (kind: string, cwd: string) => `spawned agent a-9 (kind ${kind}, cwd ${cwd || 'root'})`) as never,
    agentCount: vi.fn(() => 0) as never,
    getAgentCommand: vi.fn(() => '') as never,
    ...opts,
  };
}

let hostSeq = 0;
function makeHost(script: ScriptEntry[], recorder: TileRecorder, extra: Partial<{ config: ReviewerConfig; dir: string; retryDelayMs: number; contextBudgetTokens: number }> = {}) {
  const dir = extra.dir ?? join(tmpdir(), `fraktole-reviewer-host-${process.pid}-${++hostSeq}`);
  const provider = new FakeProvider(script);
  const events: string[] = [];
  const asks: Array<{ id: string; kind: string; agentId?: string }> = [];
  const host = new ReviewerHost({
    getConfig: async (): Promise<ReviewerConfig> => extra.config ?? { provider: 'ollama', model: 'm' },
    sessionId: 's1',
    sessionDir: dir,
    cwd: '/tmp/proj',
    recorder,
    toolContext: ctxFor(recorder),
    createProvider: () => provider,
    retryDelayMs: extra.retryDelayMs ?? 1,
    contextBudgetTokens: extra.contextBudgetTokens,
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

    recorder.record('tile-1', 'boot\nnew output');
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
    await settle(100);
    await host.setGoal('second goal');
    await settle(100);
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
    await settle(80);
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

  it('kill_agent without a grant refuses, and the model still replies', async () => {
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'kill_agent', args: { agentId: 'agent-1' } }] },
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
    await host.prompt('kill');
    await settle(80);
    // the failed tool must NOT end the turn — the model reads the error
    // result and replies (bounded by MAX_TOOL_ITERATIONS, not by a break)
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(host.conversation.some((e) => e.content.includes('no kill grant for agent-1'))).toBe(true);
    expect(host.conversation.some((e) => e.role === 'assistant' && e.content === 'refused')).toBe(true);
    expect(ctx.killAgent).not.toHaveBeenCalled();
    expect(host.status).toBe('running');
  });

  it('a tool error mid-turn does not stop the reviewer (no final reply is lost)', async () => {
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'job_status', args: { jobId: 'j-gone' } }] },
      { text: 'job not found — moving on', toolCalls: [] },
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
    expect(host.conversation.some((e) => e.role === 'assistant' && e.content === 'job not found — moving on')).toBe(true);
    expect(host.status).toBe('running');
  });

  it('a confirm-kill yes grants exactly one kill', async () => {
    const recorder = new TileRecorder();
    const ctx = ctxFor(recorder);
    const provider = new FakeProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'ask_user', args: { question: 'may I kill agent-1?', kind: 'confirm-kill', agentId: 'agent-1' } }] },
      { text: '', toolCalls: [{ id: 'c2', name: 'kill_agent', args: { agentId: 'agent-1' } }] },
      { text: '', toolCalls: [{ id: 'c3', name: 'kill_agent', args: { agentId: 'agent-1' } }] },
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
      emit: {
        status: () => undefined,
        stream: () => undefined,
        toolCall: () => undefined,
        message: () => undefined,
        goal: () => undefined,
        question: (ev) => {
          if (ev.kind === 'confirm-kill') host.answerQuestion(ev.askId, 'yes');
        },
        usage: () => undefined,
      },
    });
    await host.start();
    void host.prompt('kill with permission');
    await settle(120);
    // the failed second kill does NOT end the turn — the model replies
    expect(provider.complete).toHaveBeenCalledTimes(4);
    expect(ctx.killAgent).toHaveBeenCalledTimes(1);
    expect(ctx.killAgent).toHaveBeenCalledWith('tile-1');
    expect(host.conversation.some((e) => e.content.includes('killed tile-1'))).toBe(true);
    expect(host.conversation.some((e) => e.content.includes('no kill grant for agent-1'))).toBe(true);
    expect(host.conversation.some((e) => e.role === 'assistant' && e.content === 'done')).toBe(true);
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
    expect(ctx.spawnAgent).toHaveBeenCalledWith('opencode', '');
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
    expect(ctx.spawnAgent).toHaveBeenCalledWith('opencode', '');
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
      runBackground: vi.fn(async (c: string) => `started j-1 (${c})`) as never,
      jobStatus: vi.fn(async () => '{"jobId":"j-1","state":"exited","code":0,"output":"JOB-42"}') as never,
      jobStop: vi.fn(async () => 'stopped j-1') as never,
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
          { id: 'c1', name: 'run_background', args: { command: 'npm run dev' } },
          { id: 'c2', name: 'job_status', args: { jobId: 'j-1' } },
          { id: 'c3', name: 'job_stop', args: { jobId: 'j-1' } },
          { id: 'c4', name: 'list_messages', args: { kind: 'task' } },
          { id: 'c5', name: 'launch_agent', args: { agentId: 'agent-1', command: 'opencode' } },
          { id: 'c6', name: 'reload_test_page', args: {} },
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
    expect(contents.some((c) => c.includes('started j-1'))).toBe(true);
    expect(contents.some((c) => c.includes('"state":"exited"'))).toBe(true);
    expect(contents.some((c) => c.includes('stopped j-1'))).toBe(true);
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
});
