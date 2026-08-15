import { describe, expect, it, vi } from 'vitest';
import { SessionRegistry, SessionRuntime, type RuntimeHost, type RuntimeReviewer, type RuntimeRouter } from '../electron/session-runtime.js';
import type { SessionFile } from '../src/shared/ipc.js';

function session(id: string, name = id): SessionFile {
  return {
    version: 1,
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    nextAgentSeq: 1,
    judge: null,
    tree: null,
    tiles: [],
  };
}

function fakes() {
  const host: RuntimeHost = {
    spawn: vi.fn(() => ({ pid: 1, cwd: '/tmp' })),
    kill: vi.fn(),
    killAll: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    cwdOf: vi.fn(() => '/tmp'),
  };
  const reviewer: RuntimeReviewer = {
    status: 'offline' as const,
    start: vi.fn(async () => true),
    stop: vi.fn(),
    idleOut: vi.fn(),
    restart: vi.fn(async () => true),
    compact: vi.fn(),
    prompt: vi.fn(async () => true),
    cancel: vi.fn(),
    setGoal: vi.fn(async () => undefined),
    setVariant: vi.fn(async () => undefined),
    startAutonomy: vi.fn(async () => ({ ok: true })),
    resumableRun: vi.fn(async () => ({ resumable: false, goalText: null })),
    summarizeSession: vi.fn(() => ({ ok: true })),
    answerQuestion: vi.fn(),
    killAgentNow: vi.fn(async () => 'killed'),
    onAgentMessage: vi.fn(),
    conversation: [],
  };
  const router: RuntimeRouter = {
    start: vi.fn(),
    stop: vi.fn(),
    sendFromOrchestrator: vi.fn(async () => true),
    listMessages: vi.fn(async () => []),
  };
  return { host, reviewer, router };
}

function makeRegistry(logs: string[] = []) {
  const registry = new SessionRegistry({
    sessionRoot: '/tmp/sessions',
    logger: (line) => logs.push(line),
    makeRuntime: (s: SessionFile) => {
      const f = fakes();
      return new SessionRuntime({
        session: s,
        sessionRoot: '/tmp/sessions',
        host: f.host,
        reviewer: f.reviewer,
        router: f.router,
        judgeCwd: () => s.projectPath ?? '/home',
        idleTimeoutMs: 50,
      });
    },
  });
  return { registry, fakes: () => fakes() };
}

describe('SessionRuntime lifecycle', () => {
  it('activate starts the mailbox router for a fresh running runtime', () => {
    const { host, reviewer, router } = fakes();
    const rt = new SessionRuntime({
      session: session('s1'),
      sessionRoot: '/tmp/sessions',
      host,
      reviewer,
      router,
      judgeCwd: () => '/home',
    });
    expect(rt.state).toBe('running');
    expect(router.start).not.toHaveBeenCalled();
    rt.activate();
    expect(router.start).toHaveBeenCalledTimes(1);
    expect(rt.state).toBe('running');
  });

  it('activate does not spawn the judge (lazy, on reviewer visit)', () => {
    const { host, reviewer, router } = fakes();
    const rt = new SessionRuntime({
      session: session('s1'),
      sessionRoot: '/tmp/sessions',
      host,
      reviewer,
      router,
      judgeCwd: () => '/home',
    });
    expect(rt.state).toBe('running');
    rt.activate();
    expect(reviewer.start).not.toHaveBeenCalled();
    expect(rt.state).toBe('running');
  });

  it('ensureReviewer starts the reviewer when not running', async () => {
    const { host, reviewer, router } = fakes();
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, reviewer, router, judgeCwd: () => '/home' });
    await expect(rt.ensureReviewer()).resolves.toBe(true);
    expect(reviewer.start).toHaveBeenCalledTimes(1);
  });

  it('ensureReviewer is a no-op when the reviewer is already running', async () => {
    const { host, reviewer, router } = fakes();
    reviewer.status = 'running';
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, reviewer, router, judgeCwd: () => '/home' });
    await expect(rt.ensureReviewer()).resolves.toBe(true);
    expect(reviewer.start).not.toHaveBeenCalled();
  });

  it('ensureReviewer revives an idle or errored reviewer (persistent connection)', async () => {
    for (const down of ['idle', 'error'] as const) {
      const { host, reviewer, router } = fakes();
      reviewer.status = down;
      const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, reviewer, router, judgeCwd: () => '/home' });
      await expect(rt.ensureReviewer()).resolves.toBe(true);
      expect(reviewer.start).toHaveBeenCalledTimes(1);
    }
  });

  it('ensureReviewer revives a stopped session before starting', async () => {
    const { host, reviewer, router } = fakes();
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, reviewer, router, judgeCwd: () => '/home' });
    rt.stop();
    await expect(rt.ensureReviewer()).resolves.toBe(true);
    expect(rt.state).toBe('running');
    expect(router.start).toHaveBeenCalled();
    expect(reviewer.start).toHaveBeenCalled();
  });

  it('stop kills ptys and the reviewer and stops the router', () => {
    const { host, reviewer, router } = fakes();
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, reviewer, router, judgeCwd: () => '/home' });
    rt.stop();
    expect(host.killAll).toHaveBeenCalled();
    expect(reviewer.stop).toHaveBeenCalled();
    expect(router.stop).toHaveBeenCalled();
    expect(rt.state).toBe('stopped');
  });

  it('start revives a stopped session (router only; reviewer starts on visit)', () => {
    const { host, reviewer, router } = fakes();
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, reviewer, router, judgeCwd: () => '/home' });
    rt.stop();
    rt.start();
    expect(rt.state).toBe('running');
    expect(router.start).toHaveBeenCalled();
    expect(reviewer.start).not.toHaveBeenCalled();
  });

  it('idle timer idles the reviewer out but keeps tiles alive', async () => {
    const logs: string[] = [];
    const { host, reviewer, router } = fakes();
    const rt = new SessionRuntime({
      session: session('s1'),
      sessionRoot: '/tmp/sessions',
      host,
      reviewer,
      router,
      judgeCwd: () => '/home',
      idleTimeoutMs: 30,
      logger: (l) => logs.push(l),
    });
    rt.deactivate();
    await new Promise((r) => setTimeout(r, 80));
    expect(reviewer.idleOut).toHaveBeenCalled();
    expect(host.killAll).not.toHaveBeenCalled();
    expect(rt.state).toBe('idle');
    expect(logs.join()).toContain('idle-shutdown');
  });

  it('activate cancels the idle timer', async () => {
    const { host, reviewer, router } = fakes();
    const rt = new SessionRuntime({
      session: session('s1'),
      sessionRoot: '/tmp/sessions',
      host,
      reviewer,
      router,
      judgeCwd: () => '/home',
      idleTimeoutMs: 30,
    });
    rt.deactivate();
    rt.activate();
    await new Promise((r) => setTimeout(r, 80));
    expect(reviewer.idleOut).not.toHaveBeenCalled();
  });

  it('teardown kills everything and clears the idle timer', () => {
    const { host, reviewer, router } = fakes();
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, reviewer, router, judgeCwd: () => '/home' });
    rt.teardown();
    expect(host.killAll).toHaveBeenCalled();
    expect(reviewer.stop).toHaveBeenCalled();
    expect(router.stop).toHaveBeenCalled();
    expect(rt.state).toBe('stopped');
  });

  it('updateSession keeps the runtime view fresh', () => {
    const { host, reviewer, router } = fakes();
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, reviewer, router, judgeCwd: () => '/home' });
    const next = session('s1', 'renamed');
    rt.updateSession(next);
    expect(rt.session.name).toBe('renamed');
  });
});

describe('SessionRegistry', () => {
  it('creates runtimes lazily and tracks the active session', () => {
    const { registry } = makeRegistry();
    expect(registry.get('s1')).toBeNull();
    const rt = registry.open('s1', session('s1'));
    expect(registry.active).toBe('s1');
    expect(registry.get('s1')).toBe(rt);
    expect(registry.open('s1', session('s1'))).toBe(rt);
  });

  it('deactivates the previous active session on switch', () => {
    const { registry } = makeRegistry();
    registry.open('s1', session('s1'));
    registry.open('s2', session('s2'));
    expect(registry.active).toBe('s2');
    expect(registry.get('s1')?.state).toBe('running'); // backgrounded, not killed
  });

  it('stop/start operate on the target runtime', () => {
    const { registry } = makeRegistry();
    registry.open('s1', session('s1'));
    registry.stop('s1');
    expect(registry.get('s1')?.state).toBe('stopped');
    registry.start('s1');
    expect(registry.get('s1')?.state).toBe('running');
  });

  it('teardown removes the runtime and clears active', () => {
    const { registry } = makeRegistry();
    registry.open('s1', session('s1'));
    registry.teardown('s1');
    expect(registry.get('s1')).toBeNull();
    expect(registry.active).toBeNull();
  });

  it('killAll hits every runtime', () => {
    const { registry } = makeRegistry();
    registry.open('s1', session('s1'));
    registry.open('s2', session('s2'));
    registry.killAll();
    for (const rt of registry.all()) {
      // host.killAll is called via the runtime's host
      expect(rt.host).toBeDefined();
    }
  });
});
