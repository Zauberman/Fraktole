import { describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

describe('runCli usage handling', () => {
  it('prints usage with exit 0 on --help', async () => {
    expect(await runCli(['--help'])).toBe(0);
  });

  it('exits 2 with no command', async () => {
    expect(await runCli([])).toBe(2);
  });

  it('exits 2 on unknown commands', async () => {
    expect(await runCli(['bogus'])).toBe(2);
  });

  it('exits 2 when dispatch lacks a goal', async () => {
    expect(await runCli(['dispatch'])).toBe(2);
  });

  it('prints the config path', async () => {
    expect(await runCli(['config', 'path'])).toBe(0);
  });
});
