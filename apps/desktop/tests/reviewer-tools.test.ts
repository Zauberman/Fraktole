import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewerTools } from '../electron/reviewer-tools.js';
import type { ReviewerToolContext } from '../electron/reviewer-tools.js';
import { TileRecorder } from '../electron/tile-recorder.js';

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fraktole-tools-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"x"}');
  await writeFile(join(root, 'src', 'app.ts'), 'export const answer = 42;\n// TODO: fix this\n');
  await writeFile(join(root, 'src', 'deep', 'helper.ts'), 'const s = "HELLO-TOOLS";\n');
  await writeFile(join(root, 'src', 'note.txt'), 'plain text');
  await writeFile(join(root, 'node_modules', 'dep.js'), 'const TODO = 1;');
  await writeFile(join(root, '.hidden'), 'secret');
  return root;
}

function ctxFor(cwd: string): ReviewerToolContext {
  return {
    sessionId: 's1',
    sessionDir: '/tmp/sessions/s1',
    cwd,
    recorder: new TileRecorder(),
    router: { sendFromOrchestrator: async () => true },
    tileOfAgent: () => null,
    agentOfTile: () => null,
    cwdOfAgent: () => null,
  };
}

const tools = new ReviewerTools();

describe('list_dir', () => {
  it('lists the top level: directories first, files with sizes, sorted', async () => {
    const root = await makeTree();
    const out = await tools.run('list_dir', {}, ctxFor(root));
    expect(out).toContain('package.json (12 B)');
    expect(out).toContain('src/');
    expect(out.indexOf('src/')).toBeLessThan(out.indexOf('package.json'));
  });

  it('recurses with depth and skips hidden entries', async () => {
    const root = await makeTree();
    const out = await tools.run('list_dir', { depth: 2 }, ctxFor(root));
    expect(out).toContain('src/deep/');
    expect(out).not.toContain('node_modules/');
    expect(out).not.toContain('.hidden');
    const deep = await tools.run('list_dir', { depth: 3 }, ctxFor(root));
    expect(deep).toContain('src/deep/helper.ts');
  });

  it('includeHidden surfaces dotfiles', async () => {
    const root = await makeTree();
    const out = await tools.run('list_dir', { includeHidden: true }, ctxFor(root));
    expect(out).toContain('.hidden');
  });

  it('errors cleanly on a missing path', async () => {
    const root = await makeTree();
    const out = await tools.run('list_dir', { path: '/definitely/not/here' }, ctxFor(root));
    expect(out).toContain('error:');
  });
});

describe('search_files', () => {
  it('finds regex matches with relative paths and line numbers', async () => {
    const root = await makeTree();
    const out = await tools.run('search_files', { pattern: 'TODO' }, ctxFor(root));
    expect(out).toContain('src/app.ts:2: // TODO: fix this');
  });

  it('skips node_modules by default', async () => {
    const root = await makeTree();
    const out = await tools.run('search_files', { pattern: 'const TODO' }, ctxFor(root));
    expect(out).not.toContain('node_modules');
  });

  it('honors the glob filter', async () => {
    const root = await makeTree();
    const out = await tools.run('search_files', { pattern: '.', glob: '*.ts' }, ctxFor(root));
    expect(out).toContain('src/app.ts:1:');
    expect(out).toContain('src/deep/helper.ts:1:');
    expect(out).not.toContain('note.txt');
  });

  it('caps matches and reports no-match cleanly', async () => {
    const root = await makeTree();
    const none = await tools.run('search_files', { pattern: 'ZZZ-NOTHING' }, ctxFor(root));
    expect(none).toBe('(no matches)');
    const capped = await tools.run('search_files', { pattern: '.', maxMatches: 2 }, ctxFor(root));
    expect(capped.split('\n').length).toBeLessThanOrEqual(3);
  });

  it('reports bad regexes cleanly', async () => {
    const root = await makeTree();
    const out = await tools.run('search_files', { pattern: '([' }, ctxFor(root));
    expect(out).toContain('error: bad regex');
  });
});

describe('send_keystroke + type_into_tile', () => {
  it('maps named combos to escape sequences and passes literals through', async () => {
    const written: string[] = [];
    const ctx: ReviewerToolContext = {
      ...ctxFor('/tmp'),
      tileOfAgent: (id) => (id === 'agent-1' ? 'tile-1' : null),
      writeToAgent: async (_id, bytes) => {
        written.push(bytes);
        return 'sent';
      },
    };
    const out = await tools.run('send_keystroke', { agentId: 'agent-1', keys: ['shift-tab', 'enter', 'custom'] }, ctx);
    expect(out).toBe('sent');
    expect(written).toEqual(['\x1b[Z\rcustom']);
  });

  it('type_into_tile sends the text verbatim and optionally presses enter', async () => {
    const written: string[] = [];
    const ctx: ReviewerToolContext = {
      ...ctxFor('/tmp'),
      writeToAgent: async (_id, bytes) => {
        written.push(bytes);
        return 'sent';
      },
    };
    await tools.run('type_into_tile', { agentId: 'agent-1', text: 'yes' }, ctx);
    await tools.run('type_into_tile', { agentId: 'agent-1', text: 'npx build', pressEnter: true }, ctx);
    expect(written).toEqual(['yes', 'npx build\r']);
  });

  it('errors cleanly on unknown agents and missing arguments', async () => {
    const ctx: ReviewerToolContext = {
      ...ctxFor('/tmp'),
      tileOfAgent: (id) => (id === 'agent-1' ? 'tile-1' : null),
      writeToAgent: async (id) => (id === 'agent-1' ? 'sent' : `error: unknown agent ${id}`),
    };
    expect(await tools.run('send_keystroke', { agentId: 'ghost', keys: ['enter'] }, ctx)).toContain('error:');
    expect(await tools.run('type_into_tile', { agentId: 'ghost', text: 'hi' }, ctx)).toContain('error:');
    expect(await tools.run('send_keystroke', { agentId: 'agent-1', keys: [] }, ctx)).toContain('error:');
    expect(await tools.run('type_into_tile', { agentId: '', text: '' }, ctx)).toContain('error:');
  });
});

describe('read_tile', () => {
  it('full returns the entire recording, tail returns a slice', async () => {
    const root = await makeTree();
    const recorder = new TileRecorder();
    recorder.record('tile-1', 'a\nb\nc\nd\ne');
    const ctx: ReviewerToolContext = {
      ...ctxFor(root),
      recorder,
      tileOfAgent: (id) => (id === 'agent-1' ? 'tile-1' : null),
    };
    const full = await tools.run('read_tile', { agentId: 'agent-1', full: true }, ctx);
    expect(full).toBe('a\nb\nc\nd\ne');
    const tail = await tools.run('read_tile', { agentId: 'agent-1', tail: 2 }, ctx);
    expect(tail).toBe('d\ne');
  });

  it('full is capped by the result cap', async () => {
    const root = await makeTree();
    const recorder = new TileRecorder();
    recorder.record('tile-1', Array.from({ length: 4000 }, (_, i) => `line-${i}`).join('\n'));
    const ctx: ReviewerToolContext = {
      ...ctxFor(root),
      recorder,
      tileOfAgent: (id) => (id === 'agent-1' ? 'tile-1' : null),
    };
    const out = await tools.run('read_tile', { agentId: 'agent-1', full: true }, ctx);
    expect(out.length).toBeLessThan(20_000 + 100);
    expect(out).toContain('line-0');
    expect(out).toContain('[truncated]');
  });
});

describe('read_scrollback + list_messages', () => {
  it('read_scrollback serves a tail well beyond 1000 lines', async () => {
    const root = await makeTree();
    const sessionDir = join(root, 'sessions', 's1');
    await mkdir(join(sessionDir, 'scrollback'), { recursive: true });
    const lines = Array.from({ length: 1200 }, (_, i) => `sb-${i}`);
    await writeFile(join(sessionDir, 'scrollback', 'agent-1.json'), JSON.stringify({ lines }));
    const ctx: ReviewerToolContext = { ...ctxFor(root), sessionDir };
    const out = await tools.run('read_scrollback', { agentId: 'agent-1', tail: 5000 }, ctx);
    expect(out!.split('\n').length).toBe(1200);
    expect(out!.startsWith('sb-0'));
  });

  it('list_messages guides the model when the mailbox log is empty', async () => {
    const root = await makeTree();
    const ctx: ReviewerToolContext = { ...ctxFor(root), listMessages: async () => [] };
    const out = await tools.run('list_messages', {}, ctx);
    expect(out).toBe('(no messages yet — tasks you dispatch with send_message appear here)');
  });
});
