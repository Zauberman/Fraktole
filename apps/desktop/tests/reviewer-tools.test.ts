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
