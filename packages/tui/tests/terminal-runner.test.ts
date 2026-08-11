import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand, stripAnsi } from '../src/terminal-runner.js';

describe('stripAnsi', () => {
  it('removes SGR escape sequences', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m text')).toBe('green text');
    expect(stripAnsi('\x1b[1;31mbold red\x1b[0m')).toBe('bold red');
  });
});

describe('runCommand', () => {
  it('streams output and reports the exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-term-'));
    const out: string[] = [];
    const proc = runCommand({ cwd: dir, command: 'echo hello', onOutput: (t) => out.push(t) });
    const { code } = await proc.exited;
    expect(code).toBe(0);
    expect(out.join('')).toContain('hello');
  });

  it('supports pipes and quoting through bash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-term-'));
    const out: string[] = [];
    const proc = runCommand({
      cwd: dir,
      command: 'printf "%s\\n" "two words" | wc -l',
      onOutput: (t) => out.push(t),
    });
    const { code } = await proc.exited;
    expect(code).toBe(0);
    expect(out.join('').trim()).toBe('1');
  });

  it('captures failing commands with a non-zero exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-term-'));
    const proc = runCommand({ cwd: dir, command: 'exit 7', onOutput: () => {} });
    const { code } = await proc.exited;
    expect(code).toBe(7);
  });

  it('kill terminates a long-running command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-term-'));
    const proc = runCommand({ cwd: dir, command: 'sleep 30', onOutput: () => {} });
    setTimeout(() => proc.kill(), 100);
    const { code } = await proc.exited;
    expect(code).not.toBe(0); // killed by signal
  });

  it('runs with the given working directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-term-'));
    await writeFile(join(dir, 'marker.txt'), 'x');
    const out: string[] = [];
    const proc = runCommand({ cwd: dir, command: 'ls', onOutput: (t) => out.push(t) });
    await proc.exited;
    expect(out.join('')).toContain('marker.txt');
  });
});
