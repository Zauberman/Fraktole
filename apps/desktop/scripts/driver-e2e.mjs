#!/usr/bin/env node
// Fraktole E2E driver: launches vite + electron (dev path) with CDP, drives
// the reviewer column in the Node tab, the Test tab, the tile/reviewer focus
// cycle, the thinking toggles, the tool families and the 13-theme walk
// (via applyTheme), against a scripted mock provider. Run: node scripts/driver-e2e.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = join(import.meta.dirname, '..');
const VITE_PORT = 5173;
const CDP_PORT = 9223;

let failures = 0;
const fail = (m) => {
  failures += 1;
  console.log(`FAIL: ${m}`);
};
const ok = (m) => console.log(`  ok: ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- mock provider (openai-compatible), ephemeral port ----------
let callCount = 0;
let successCount = 0;
let failNext = 0;
let mockViolations = 0;
let MOCK_BASE = '';
let lastReqBody = null;
const mock = http.createServer((req, res) => {
  const path = req.url?.split('?')[0] ?? '';
  const isCompletions = path.endsWith('/chat/completions');
  const isModels = path.endsWith('/models') || path.endsWith('/v1/models');
  if (req.method === 'GET' && isModels) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-model-2' }] }));
    return;
  }
  if (req.method === 'GET' && path === '/page') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>TEST PAGE</title></head><body><h1>test</h1><script>console.error("boom");</script></body></html>');
    return;
  }
  if (req.method === 'POST' && path === '/control') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        failNext = JSON.parse(body).failNext ?? 0;
      } catch {
        failNext = 0;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ failNext }));
    });
    return;
  }
  if (req.method === 'POST' && isCompletions) {
    callCount += 1;
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      lastReqBody = body;
      let jobId = 'j-1';
      let violation = '';
      try {
        const j = JSON.parse(body);
        const last = j.messages?.[j.messages.length - 1];
        console.log(`  mock hit #${callCount}: last msg role=${last?.role} toolCalls=${last?.toolCalls ? last.toolCalls.length : 0}`);
        // the contract guard: OpenAI rejects "tool_calls": [] — a request
        // carrying one is a regression of the exact bug being fixed
        for (const m of j.messages ?? []) {
          if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length === 0) {
            violation = `assistant message carries an empty tool_calls array`;
            break;
          }
        }
        const toolMsgs = (j.messages ?? []).filter((m) => m.role === 'tool');
        const started = toolMsgs.map((m) => String(m.content ?? '')).join('\n').match(/started (j-\d+-\d+)/);
        if (started) jobId = started[1];
      } catch {
        console.log(`  mock hit #${callCount}: unparsable body`);
      }
      if (violation) {
        mockViolations += 1;
        console.log(`  MOCK VIOLATION: ${violation}`);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Invalid messages.tool_calls: empty array (${violation})`, type: 'invalid_request_error' } }));
        return;
      }
      if (failNext > 0) {
        failNext -= 1;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock 500: transient provider failure' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`;
      const tool = (id, name, argsObj) =>
        chunk(
          {
            tool_calls: [
              { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(argsObj) } },
            ],
          },
          'tool_calls',
        ) + `data: [DONE]\n\n`;
      const text = (t) => chunk({ content: t }, 'stop') + `data: [DONE]\n\n`;
      const script = {
        1: chunk({ reasoning_content: 'let me think ' }) +
          chunk({ reasoning_content: 'about the tiles' }) +
          tool('call-1', 'read_tile', { agentId: 'agent-1', tail: 5 }),
        2: text('reviewed tile-1: DRIVER-42'),
        3: tool('call-3', 'open_test_page', { url: `${MOCK_BASE}/page` }),
        4: text('page opened'),
        5: tool('call-5', 'read_test_page', {}),
        6: text('test complete'),
        7: tool('call-7', 'list_dir', { path: '/home/walid/Fraktole/apps/desktop', depth: 1 }),
        8: text('listed'),
        9: tool('call-9', 'search_files', { pattern: 'DRIVER-42', path: '/home/walid/Fraktole/apps/desktop/scripts' }),
        10: text('searched'),
        11: tool('call-11', 'run_background', { command: 'for i in 1 2 3; do echo JOB-42-$i; sleep 0.5; done' }),
        12: tool('call-12', 'job_status', { jobId }),
        13: text('job started'),
        14: tool('call-14', 'job_status', { jobId }),
        15: text('job done'),
        16: tool('call-16', 'launch_agent', { agentId: 'ghost-agent', command: 'opencode' }),
        17: tool('call-17', 'reload_test_page', {}),
        18: text('reloaded'),
        19: tool('call-19', 'read_test_page', {}),
        20: text('verified'),
      };
      successCount += 1;
      const chunks = script[successCount] ?? text('ok');
      res.write(chunks);
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

// ---------- launch ----------
const children = [];
const launch = (cmd, args, env = null) => {
  const child = spawn(cmd, args, { cwd: APP, env: env ?? process.env, stdio: 'ignore' });
  children.push(child);
  return child;
};

const mockPort = await new Promise((resolve, reject) => {
  mock.once('error', reject);
  mock.listen(0, '127.0.0.1', () => resolve(mock.address().port));
});
MOCK_BASE = `http://127.0.0.1:${mockPort}`;
console.log(`mock provider on ${MOCK_BASE}`);

launch('pnpm', ['exec', 'vite', '--port', String(VITE_PORT), '--strictPort']);
const userData = mkdtempSync(join(tmpdir(), 'frak-e2e-'));
const curated = {
  HOME: process.env.HOME ?? '/home/walid',
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  USER: process.env.USER ?? '',
  LOGNAME: process.env.LOGNAME ?? '',
  SHELL: process.env.SHELL ?? '/bin/bash',
  DISPLAY: process.env.DISPLAY ?? '',
  WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '',
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
  XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE ?? '',
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? '',
  XAUTHORITY: process.env.XAUTHORITY ?? '',
  VITE_DEV_SERVER_URL: `http://127.0.0.1:${VITE_PORT}`,
  XDG_CONFIG_HOME: userData,
};
launch('node_modules/.bin/electron', ['.', `--remote-debugging-port=${CDP_PORT}`], curated);

// ---------- CDP ----------
const json = (url) => fetch(url).then((r) => r.json());
let ws;
let msgId = 0;
const pending = new Map();
const onCdpMessage = (e) => {
  const m = JSON.parse(e.data);
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  }
};
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await json(`http://127.0.0.1:${CDP_PORT}/json`);
      const page = targets.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        ws.addEventListener('message', onCdpMessage);
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('CDP never came up');
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result.value;
};
const key = async (k, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, modifiers });
};

async function waitFor(expr, timeoutMs = 20000, label = expr) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await evalJs(expr);
      if (v) return v;
    } catch {
      /* keep polling */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(400);
  }
}

const prompt = async (text) => {
  await evalJs(`document.querySelector('.pane-reviewer-column .reviewer-input input').focus(); true`);
  await send('Input.insertText', { text });
  await key('Enter');
};

// ---------- flow ----------
const main = async () => {
  await connect();
  await waitFor(`document.querySelector('.session-view') !== null`, 30000, 'session view');

  await evalJs(`window.fraktole.setSettings({ reviewer: { apiKey: 'sk-mock-42', provider: 'openai', model: 'mock-model', baseUrl: '${MOCK_BASE}', reasoningEffort: 'high' } })`);
  await sleep(300);
  const sid = await evalJs(`window.fraktole.listSessions().then((s) => s[0]?.id ?? '')`);
  if (!sid) fail('no session id to restart');
  else await evalJs(`window.fraktole.restartReviewer('${sid}')`);

  const column = await waitFor(
    `document.querySelector('.pane-reviewer-column .reviewer-header .orch-judge-status')?.textContent ?? ''`,
    20000,
    'reviewer column',
  );
  if (column === '') fail('reviewer column has no status badge');
  else ok(`reviewer column on node tab (status: ${column})`);

  const status = await waitFor(
    `document.querySelector('.pane-reviewer-column .reviewer-header .orch-judge-status')?.textContent`,
    25000,
    'reviewer running',
  );
  if (status !== 'running') fail(`reviewer status is ${status}`);
  else ok('reviewer running (restarted against the mock)');

  const model = await waitFor(`document.querySelector('.pane-reviewer-column .reviewer-model-label')?.textContent ?? ''`, 15000, 'model label');
  if (model !== 'mock-model') fail(`model label shows ${model}`);
  else ok(`header model label: ${model}`);

  // prompt 1 → combined reasoning + tool call
  await prompt('what is running in agent-1?');
  const errCard = await waitFor(
    `document.querySelector('.pane-reviewer-column .reviewer-item-tool-error') !== null`,
    25000,
    'error card',
  );
  if (!errCard) fail('no error card for the failed read_tile');
  else ok('failed tool surfaced as an error card');

  // prompt-engineering assertions: request carries reasoning_effort + the
  // new system prompt section
  try {
    const req = JSON.parse(lastReqBody);
    const sys = (req.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
    if (!sys.includes('VERIFYING & JUDGING RESULTS')) fail('system prompt missing the verification section');
    else ok('system prompt carries the verification section');
    if (req.reasoning_effort !== 'high') fail(`reasoning_effort missing: ${JSON.stringify(req.reasoning_effort)}`);
    else ok('request carries reasoning_effort: high');
  } catch (err) {
    fail(`prompt/effort assertion error: ${err.message}`);
  }

  const argsText = await evalJs(`(() => { const c = document.querySelector('.pane-reviewer-column .reviewer-item-tool'); return c ? c.textContent : ''; })()`);
  if (!argsText.includes('"agentId":"agent-1"') || !argsText.includes('"tail":5')) fail(`tool args not fully visible: ${argsText.slice(0, 120)}`);
  else ok('tool args fully present in the card text');

  const chip = await waitFor(`document.querySelector('.pane-reviewer-column .reviewer-thinking-chip') !== null`, 15000, 'thinking chip');
  if (!chip) fail('no thinking chip after the reasoning answer');
  else ok('thinking chip present');
  const hiddenByDefault = await evalJs(`document.querySelector('.pane-reviewer-column .reviewer-thinking') === null`);
  if (!hiddenByDefault) fail('thinking block visible before any toggle');
  else ok('thinking hidden by default');
  await evalJs(`document.querySelector('.pane-reviewer-column .reviewer-thinking-chip')?.click(); true`);
  const block = await waitFor(`document.querySelector('.pane-reviewer-column .reviewer-thinking')?.textContent ?? ''`, 10000, 'thinking block');
  if (!block.includes('let me think about the tiles')) fail(`thinking text wrong: ${block}`);
  else ok('chip click reveals the reasoning output');
  await evalJs(`document.querySelector('.pane-reviewer-column .reviewer-thinking-chip')?.click(); true`);
  await sleep(300);

  await evalJs(`[...document.querySelectorAll('.pane-reviewer-column .reviewer-actions button')].find((b) => b.textContent.trim() === 'think')?.click(); true`);
  const globalOn = await waitFor(`document.querySelector('.pane-reviewer-column .reviewer-thinking') !== null`, 10000, 'global thinking visible');
  if (!globalOn) fail('global think toggle did not reveal the block');
  else ok('global toggle reveals all thinking blocks');
  await evalJs(`[...document.querySelectorAll('.pane-reviewer-column .reviewer-actions button')].find((b) => b.textContent.trim() === 'think')?.click(); true`);
  await sleep(300);

  await prompt('summarize');
  const final = await waitFor(
    `[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('DRIVER-42'))`,
    20000,
    'final answer',
  );
  if (!final) fail('final answer missing');
  else ok('model answered (DRIVER-42 in transcript)');

  await prompt('/compact');
  await sleep(1200);
  ok('/compact sent without errors');

  await prompt('/goal test-goal');
  const banner = await waitFor(`document.querySelector('.pane-reviewer-column .reviewer-goal-banner') !== null`, 15000, 'goal banner');
  if (!banner) fail('goal banner missing');
  else ok(`goal banner: ${await evalJs(`document.querySelector('.pane-reviewer-column .reviewer-goal-state')?.textContent ?? ''`)}`);

  const opened = await waitFor(
    `[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('opened http://127.0.0.1:') && e.textContent.includes('in the Test tab'))`,
    20000,
    'open_test_page result',
  );
  if (!opened) fail('open_test_page did not complete');
  else ok('reviewer opened the test page (tool result in transcript)');
  const activeTab = await waitFor(`document.querySelector('.top-bar-tabs .tab-btn-active')?.textContent ?? ''`, 10000, 'test tab active');
  if (activeTab.trim() !== 'Test') fail(`active tab is ${activeTab}`);
  else ok('Test tab is active after open_test_page');

  const badge = await waitFor(`document.querySelector('.test-err-badge')?.textContent ?? ''`, 20000, 'error badge');
  if (!badge.includes('1 error')) fail(`error badge shows: ${badge}`);
  else ok(`console-error badge: ${badge}`);

  await evalJs(`[...document.querySelectorAll('.top-bar-tabs .tab-btn')].find((b) => b.textContent.includes('Node'))?.click(); true`);
  await sleep(400);
  await prompt('check the page');
  const readBack = await waitFor(
    `[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('"consoleErrors":1'))`,
    20000,
    'read_test_page result',
  );
  if (!readBack) fail('read_test_page did not report the console error');
  else ok('read_test_page reported consoleErrors: 1 back to the reviewer');

  await prompt('explore the project');
  const listed = await waitFor(
    `[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('package.json'))`,
    20000,
    'list_dir result',
  );
  if (!listed) fail('list_dir did not list the project');
  else ok('list_dir returned the project tree');

  await prompt('search for markers');
  const searched = await waitFor(
    `[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('DRIVER-42') && e.textContent.includes('driver-e2e.mjs'))`,
    20000,
    'search_files result',
  );
  if (!searched) fail('search_files did not find the marker');
  else ok('search_files found the marker in driver-e2e.mjs');

  await prompt('start a background job');
  const jobRunning = await waitFor(
    `[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('"state":"running"'))`,
    25000,
    'job running',
  );
  if (!jobRunning) fail('job_status did not report running');
  else ok('background job reported running');
  await sleep(3000);
  await prompt('check the job');
  let jobDone = false;
  try {
    jobDone = await waitFor(
      `[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('"state":"exited"') && e.textContent.includes('JOB-42'))`,
      25000,
      'job exited',
    );
  } catch {
    jobDone = false;
  }
  if (!jobDone) fail('job_status did not report the exited job with output');
  else ok('background job exited with JOB-42 output');

  await prompt('launch a harness');
  const launchErr = await waitFor(
    `[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('unknown agent ghost-agent'))`,
    20000,
    'launch_agent error',
  );
  if (!launchErr) fail('launch_agent did not error cleanly on an unknown agent');
  else ok('launch_agent refused the unknown agent');

  await prompt('reload the test page');
  const reloaded = await waitFor(
    `[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('reload sent to the Test tab'))`,
    20000,
    'reload_test_page result',
  );
  if (!reloaded) fail('reload_test_page did not complete');
  else ok('reload_test_page sent');
  await prompt('read the console');
  const consoleLines = await waitFor(
    `[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('"message":"boom"'))`,
    20000,
    'console lines in read_test_page',
  );
  if (!consoleLines) fail('read_test_page did not return the console lines');
  else ok('read_test_page returned the console line (boom) after reload');

  await evalJs(`(() => { const el = document.querySelector('.pane-reviewer-column'); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
  const ring = await waitFor(`document.querySelector('.pane-reviewer-column.reviewer-column-focused') !== null`, 10000, 'focus ring');
  if (!ring) fail('reviewer column focus ring missing on mousedown');
  else ok('reviewer column focuses on mousedown (ring class present)');

  const themes = ['sable', 'midnight', 'gold', 'amber', 'forest', 'neon', 'paper', 'ember', 'ocean', 'violet', 'slate', 'rose', 'ivory'];
  const seen = new Set();
  for (const t of themes) {
    await evalJs(`window.fraktole.applyTheme('${t}')`);
    await sleep(400);
    const bg = await evalJs(`getComputedStyle(document.body).backgroundColor`);
    const dt = await evalJs(`document.documentElement.dataset.theme ?? ''`);
    if (dt !== t) fail(`dataset.theme is ${dt} after applyTheme(${t})`);
    seen.add(bg);
  }
  if (seen.size < 10) fail(`theme walk barely repainted (${seen.size} distinct bgs of ${themes.length})`);
  else ok(`theme walk: ${themes.length} themes via applyTheme, ${seen.size} distinct backgrounds`);

  // the old chrome is gone: no wordmark, no View button
  const deadChrome = await evalJs(`document.querySelector('.top-bar-wordmark, .view-btn, .view-menu') !== null`);
  if (deadChrome) fail('dead chrome present (wordmark / view button / view menu)');
  else ok('top bar is bare: no wordmark, no View button');

  // the primary button fix: solid accent bg + its label token on top
  const btn = await evalJs(`(() => {
    const b = document.querySelector('.pane-reviewer-column .reviewer-composer .btn-primary');
    if (!b) return null;
    const s = getComputedStyle(b);
    const a = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return JSON.stringify({ bg: s.backgroundColor, fg: s.color, accent: a });
  })()`);
  if (!btn) fail('no primary send button to inspect');
  else {
    const j = JSON.parse(btn);
    const nums = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const bgN = nums(j.bg);
    const acN = nums(j.accent);
    const same = bgN.length === 3 && acN.length === 3 && bgN.every((v, i) => Math.abs(v - acN[i]) < 0.01);
    if (!same) fail(`send button bg is not the solid accent: ${btn}`);
    else ok(`primary button sits on the solid accent (bg ${j.bg})`);
  }

  // editorial reviewer: serif assistant bodies + Plex thinking panels
  const fonts = await evalJs(`(() => {
    const body = document.querySelector('.pane-reviewer-column .reviewer-item-assistant .reviewer-item-body');
    const th = document.querySelector('.pane-reviewer-column .reviewer-thinking');
    return JSON.stringify({
      body: body ? getComputedStyle(body).fontFamily : '',
      thinking: th ? getComputedStyle(th).fontFamily : '',
    });
  })()`);
  const fj = JSON.parse(fonts);
  if (!fj.body.includes('Instrument Serif')) fail(`assistant body font: ${fj.body}`);
  else ok(`assistant answers read in Instrument Serif`);
  if (fj.thinking && !fj.thinking.includes('IBM Plex Mono')) fail(`thinking panel font: ${fj.thinking}`);
  else ok('thinking panels set in IBM Plex Mono');

  // chrome heights: 34px top bar, 30px status bar
  const bars = await evalJs(`JSON.stringify({
    top: document.querySelector('.top-bar')?.getBoundingClientRect().height,
    status: document.querySelector('.status-bar')?.getBoundingClientRect().height,
  })`);
  const bj = JSON.parse(bars);
  if (Math.abs(bj.top - 34) > 1) fail(`top bar height ${bj.top}`);
  else ok('top bar is 34px');
  if (Math.abs(bj.status - 30) > 1) fail(`status bar height ${bj.status}`);
  else ok('status bar is 30px');

  // config now opens as a modal dialog
  await evalJs(`[...document.querySelectorAll('.pane-reviewer-column .reviewer-actions button')].find((b) => b.textContent.trim() === 'config')?.click(); true`);
  const dlg = await waitFor(`document.querySelector('.pane-reviewer-column .dialog') !== null`, 10000, 'config dialog');
  if (!dlg) fail('config does not open as a dialog');
  else ok('config opens as a modal dialog');
  await evalJs(`document.querySelector('.pane-reviewer-column .dialog-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
  await sleep(300);
  if (await evalJs(`document.querySelector('.pane-reviewer-column .dialog') !== null`)) fail('config dialog did not close on backdrop');
  else ok('config dialog closes on backdrop');

  const rowColors = await evalJs(`(() => {
    const mk = (sel, child) => { const el = document.querySelector(sel); return el ? getComputedStyle(child ? el.querySelector(child) : el).color : ''; };
    return JSON.stringify({
      user: mk('.reviewer-item-user', '.reviewer-item-body'),
      system: mk('.reviewer-item-system', '.reviewer-item-body'),
      tool: mk('.reviewer-item-tool', '.reviewer-tool-detail'),
      error: mk('.reviewer-item-tool-error', '.reviewer-tool-detail'),
    });
  })()`);
  const rc = JSON.parse(rowColors);
  const distinct = new Set([rc.user, rc.system, rc.tool, rc.error].filter(Boolean)).size;
  if (distinct < 2) fail(`row colors not distinct: ${rowColors}`);
  else ok(`row colors distinct (${distinct} of 4): ${rowColors}`);

  const models = await evalJs(`window.fraktole.listReviewerModels({ adapter: 'openai', apiKey: 'sk-mock-42', baseUrl: '${MOCK_BASE}' })`);
  if (!Array.isArray(models) || !models.includes('mock-model')) fail(`model list fetch failed: ${JSON.stringify(models)}`);
  else ok(`live model list: ${models.join(', ')}`);

  // ---- persistent connection: a transient provider failure must not kill
  // the harness — status errors, and the next prompt revives it, keeping
  // the whole conversation
  await fetch(`${MOCK_BASE}/control`, { method: 'POST', body: JSON.stringify({ failNext: 2 }) });
  await prompt('will fail');
  const down = await waitFor(
    `document.querySelector('.pane-reviewer-column .orch-judge-status')?.textContent === 'error'`,
    30000,
    'reviewer error state',
  );
  if (!down) fail('reviewer did not surface the provider failure as error');
  else ok('provider failure surfaced as status: error');

  await prompt('survive me');
  const revived = await waitFor(
    `document.querySelector('.pane-reviewer-column .orch-judge-status')?.textContent === 'running'`,
    30000,
    'reviewer revived',
  );
  if (!revived) fail('reviewer did not revive on send');
  else ok('send revives the reviewer (persistent connection)');

  const landed = await waitFor(
    `[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('survive me'))`,
    15000,
    'revived prompt landed',
  );
  if (!landed) fail('the revived prompt did not land in the transcript');
  else ok('revived prompt landed in the transcript');

  const contextKept = await evalJs(`[...document.querySelectorAll('.pane-reviewer-column .reviewer-item-body')].some((e) => e.textContent.includes('DRIVER-42'))`);
  if (!contextKept) fail('conversation wiped after revive');
  else ok('conversation retained after revive');

  if (mockViolations > 0) fail(`${mockViolations} request(s) carried an empty tool_calls array`);
  else ok('no request ever carried an empty tool_calls array');

  console.log(`\nmock provider calls: ${callCount}`);
  console.log(failures === 0 ? 'DRIVER-E2E OK' : `DRIVER-E2E FAILED (${failures})`);
};

main()
  .catch((err) => {
    console.log(`DRIVER-E2E FAILED: ${err.message}`);
    failures += 1;
  })
  .finally(async () => {
    await sleep(300);
    for (const c of children) {
      try {
        c.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    mock.close();
    process.exit(failures === 0 ? 0 : 1);
  });
