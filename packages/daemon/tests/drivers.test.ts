import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DriverProcess } from '../src/drivers/index.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

function fakeChild(): EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 1234;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

async function loadDriver(path: string): Promise<Record<string, unknown>> {
  return import(path);
}

afterEach(() => {
  vi.resetModules();
  spawnMock.mockReset();
});

describe('opencodeDriver', () => {
  it('spawns opencode run with the worktree as cwd and PWD', async () => {
    const { opencodeDriver } = (await loadDriver('../src/drivers/opencode.js')) as typeof import('../src/drivers/opencode.js');
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const hooks = { onStdout: vi.fn(), onStderr: vi.fn(), onExit: vi.fn() };
    const proc: DriverProcess = opencodeDriver.spawn(
      { worktreePath: '/wt/t1', goal: 'fix it', env: {}, taskId: 't1' },
      hooks,
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'opencode',
      ['run', 'fix it'],
      expect.objectContaining({ cwd: '/wt/t1' }),
    );
    const env = spawnMock.mock.calls[0]![2].env as Record<string, string>;
    expect(env.PWD).toBe('/wt/t1');

    child.stdout.emit('data', Buffer.from('hi'));
    child.stderr.emit('data', Buffer.from('warn'));
    expect(hooks.onStdout).toHaveBeenCalledWith('hi');
    expect(hooks.onStderr).toHaveBeenCalledWith('warn');

    child.emit('exit', 0, null);
    await proc.exited;
    expect(hooks.onExit).toHaveBeenCalledWith(0, null);
  });
});

describe('claudeDriver', () => {
  it('spawns claude -p with text output and the worktree cwd', async () => {
    const { claudeDriver } = (await loadDriver('../src/drivers/claude.js')) as typeof import('../src/drivers/claude.js');
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const proc = claudeDriver.spawn(
      { worktreePath: '/wt/c1', goal: 'explain', env: {}, taskId: 't1' },
      { onStdout: vi.fn(), onStderr: vi.fn(), onExit: vi.fn() },
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      ['-p', 'explain', '--output-format', 'text'],
      expect.objectContaining({ cwd: '/wt/c1' }),
    );
    const env = spawnMock.mock.calls[0]![2].env as Record<string, string>;
    expect(env.PWD).toBe('/wt/c1');
    expect(proc.pid).toBe(1234);
  });
});

describe('pluginDriver', () => {
  it('spawns the plugin command with args plus the goal', async () => {
    const { pluginDriver } = (await loadDriver('../src/drivers/plugin.js')) as typeof import('../src/drivers/plugin.js');
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    pluginDriver({ id: 'my-agent', command: 'npx', args: ['-y', 'my-agent', '--cwd'] }).spawn(
      { worktreePath: '/wt/p1', goal: 'do the thing', env: {}, taskId: 't1' },
      { onStdout: vi.fn(), onStderr: vi.fn(), onExit: vi.fn() },
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['-y', 'my-agent', '--cwd', 'do the thing'],
      expect.objectContaining({ cwd: '/wt/p1' }),
    );
  });
});
