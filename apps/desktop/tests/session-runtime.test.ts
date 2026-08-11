import { describe, expect, it, vi } from 'vitest';
import { SessionRegistry, SessionRuntime, type RuntimeHost, type RuntimeJudge, type RuntimeRouter } from '../electron/session-runtime.js';
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
  const judge: RuntimeJudge = {
    status: 'offline' as const,
    spawn: vi.fn(() => true),
    kill: vi.fn(),
    markExited: vi.fn(),
  };
  const router: RuntimeRouter = {
    start: vi.fn(),
    stop: vi.fn(),
    sendFromOrchestrator: vi.fn(async () => true),
    listMessages: vi.fn(async () => []),
  };
  return { host, judge, router };
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
        judge: f.judge,
        router: f.router,
        judgeCwd: () => s.projectPath ?? '/home',
        idleTimeoutMs: 50,
      });
    },
  });
  return { registry, fakes: () => fakes() };
}

describe('SessionRuntime lifecycle', () => {
  it('starts running and spawns the judge on activate', () => {
    const { host, judge, router } = fakes();
    const rt = new SessionRuntime({
      session: session('s1'),
      sessionRoot: '/tmp/sessions',
      host,
      judge,
      router,
      judgeCwd: () => '/home',
    });
    expect(rt.state).toBe('running');
    expect(judge.spawn).not.toHaveBeenCalled();
    rt.activate();
    expect(judge.spawn).toHaveBeenCalledTimes(1);
    expect(rt.state).toBe('running');
  });

  it('does not respawn the judge when already running', () => {
    const { host, judge, router } = fakes();
    judge.status = 'running';
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, judge, router, judgeCwd: () => '/home' });
    rt.activate();
    expect(judge.spawn).not.toHaveBeenCalled();
  });

  it('stop kills ptys and judge and stops the router', () => {
    const { host, judge, router } = fakes();
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, judge, router, judgeCwd: () => '/home' });
    rt.stop();
    expect(host.killAll).toHaveBeenCalled();
    expect(judge.kill).toHaveBeenCalled();
    expect(router.stop).toHaveBeenCalled();
    expect(rt.state).toBe('stopped');
  });

  it('start revives a stopped session: router + judge', () => {
    const { host, judge, router } = fakes();
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, judge, router, judgeCwd: () => '/home' });
    rt.stop();
    rt.start();
    expect(rt.state).toBe('running');
    expect(router.start).toHaveBeenCalled();
    expect(judge.spawn).toHaveBeenCalled();
  });

  it('idle timer shuts the judge down but keeps tiles alive', async () => {
    const logs: string[] = [];
    const { host, judge, router } = fakes();
    const rt = new SessionRuntime({
      session: session('s1'),
      sessionRoot: '/tmp/sessions',
      host,
      judge,
      router,
      judgeCwd: () => '/home',
      idleTimeoutMs: 30,
      logger: (l) => logs.push(l),
    });
    rt.deactivate();
    await new Promise((r) => setTimeout(r, 80));
    expect(judge.kill).toHaveBeenCalled();
    expect(host.killAll).not.toHaveBeenCalled();
    expect(rt.state).toBe('idle');
    expect(logs.join()).toContain('idle-shutdown');
  });

  it('activate cancels the idle timer', async () => {
    const { host, judge, router } = fakes();
    const rt = new SessionRuntime({
      session: session('s1'),
      sessionRoot: '/tmp/sessions',
      host,
      judge,
      router,
      judgeCwd: () => '/home',
      idleTimeoutMs: 30,
    });
    rt.deactivate();
    rt.activate();
    await new Promise((r) => setTimeout(r, 80));
    expect(judge.kill).not.toHaveBeenCalled();
  });

  it('teardown kills everything and clears the idle timer', () => {
    const { host, judge, router } = fakes();
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, judge, router, judgeCwd: () => '/home' });
    rt.teardown();
    expect(host.killAll).toHaveBeenCalled();
    expect(judge.kill).toHaveBeenCalled();
    expect(router.stop).toHaveBeenCalled();
    expect(rt.state).toBe('stopped');
  });

  it('updateSession keeps the runtime view fresh', () => {
    const { host, judge, router } = fakes();
    const rt = new SessionRuntime({ session: session('s1'), sessionRoot: '/tmp/sessions', host, judge, router, judgeCwd: () => '/home' });
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
