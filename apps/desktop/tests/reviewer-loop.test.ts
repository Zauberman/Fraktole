import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewerHost, type ReviewerConfig } from '../electron/reviewer.js';
import type { ReviewerToolContext } from '../electron/reviewer-tools.js';
import type { ReviewerState } from '../src/shared/ipc.js';
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
    killAgent: vi.fn(async () => 'killed tile-1') as never,
    spawnAgent: vi.fn(async (kind: string, cwd: string) => `spawned agent a-9 (kind ${kind}, cwd ${cwd || 'root'})`) as never,
    agentCount: vi.fn(() => 0) as never,
    getAgentCommand: vi.fn(() => '') as never,
    ...opts,
  };
}

let hostSeq = 0;
function makeHost(script: ScriptEntry[], recorder: TileRecorder, extra: Partial<{ config: ReviewerConfig; dir: string }> = {}) {
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
    conversationFile: extra.dir ? join(extra.dir, 'conversation.jsonl') : uniqueConversationFile(),
    emit: {
      status: (s) => events.push(`status:${s}`),
      stream: (d) => events.push(`stream:${d}`),
      toolCall: (ev) => events.push(`tool:${ev.name}:${ev.state}`),
      message: () => events.push('msg'),
      goal: (ev) => events.push(`goal:${ev.goal?.state ?? 'none'}`),
      question: (ev) => {
        asks.push({ id: ev.askId, kind: ev.kind, agentId: ev.agentId });
        events.push(`question:${ev.kind}`);
      },
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
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined },
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
      emit: { status: (s) => events.push(`status:${s}`), stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined },
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

  it('forced compact drops old exchanges but keeps the last user turn', async () => {
    const recorder = recorderWith('x'.repeat(100));
    const script: ScriptEntry[] = [];
    for (let i = 0; i < 10; i++) {
      script.push({ text: '', toolCalls: [{ id: `c${i}`, name: 'read_tile', args: { agentId: 'agent-1', tail: 5 } }] });
    }
    script.push({ text: 'done', toolCalls: [] });
    script.push({ text: 'again', toolCalls: [] });
    const { host } = makeHost(script, recorder);
    await host.start();
    await host.prompt('dig deep');
    await settle(300);
    await host.prompt('and again');
    await settle(100);
    const before = host.conversation.length;
    expect(before).toBeGreaterThan(10);
    host.compact();
    await settle(30);
    const after = host.conversation;
    expect(after.length).toBeLessThan(before);
    expect(after.some((e) => e.content.includes('context compacted'))).toBe(true);
    // the most recent user turn survives
    const lastUser = [...after].reverse().find((e) => e.role === 'user');
    expect(lastUser?.content).toBe('and again');
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
    script.push({ text: 'final answer', toolCalls: [] });
    const { host } = makeHost(script, recorder);
    await host.start();
    await host.setGoal('big dig');
    await settle(500);
    expect(host.conversation.some((e) => e.content.includes('context compacted'))).toBe(true);
    await host.prompt('one more');
    await settle(120);
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

  it('kill_agent without a grant refuses and never kills', async () => {
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
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined },
    });
    await host.start();
    await host.prompt('kill');
    await settle(80);
    expect(provider.complete).toHaveBeenCalledTimes(1); // the failed tool ends the turn (no spin)
    expect(host.conversation.some((e) => e.content.includes('no kill grant for agent-1'))).toBe(true);
    expect(ctx.killAgent).not.toHaveBeenCalled();
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
      },
    });
    await host.start();
    void host.prompt('kill with permission');
    await settle(120);
    // the failed second kill ends the turn — 3 provider calls total
    expect(provider.complete).toHaveBeenCalledTimes(3);
    expect(ctx.killAgent).toHaveBeenCalledTimes(1);
    expect(ctx.killAgent).toHaveBeenCalledWith('tile-1');
    expect(host.conversation.some((e) => e.content.includes('killed tile-1'))).toBe(true);
    expect(host.conversation.some((e) => e.content.includes('no kill grant for agent-1'))).toBe(true);
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
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined },
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
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined },
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
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined },
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
      emit: { status: () => undefined, stream: () => undefined, toolCall: () => undefined, message: () => undefined, goal: () => undefined, question: () => undefined },
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
      },
    });
    await host.start();
    expect(models).toContain('claude-sonnet-4-5');
  });
});
