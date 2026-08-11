import { useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import type { EventEnvelope, RepoConfig, Task } from '@fraktole/core';
import type { DiscoveredDriver, TuiApi } from './api.js';
import { Boot } from './boot.js';
import { BottomBar, TopBar } from './chrome.js';
import { DispatchBox } from './dispatch-box.js';
import { GatesTab } from './gates-tab.js';
import type { OpenGate } from './gate-prompt.js';
import type { LogLine } from './agent-window.js';
import { Divider } from './primitives.js';
import { ReposTab } from './repos-tab.js';
import { SettingsTab, type SettingsState } from './settings-tab.js';
import { Sidebar, TAB_ORDER, type TabId } from './sidebar.js';
import { TasksTab } from './tasks-tab.js';
import { TerminalTab } from './terminal-tab.js';
import { SceneTransition } from './transition.js';
import { truncate } from './theme.js';
import type { WsClient } from './ws-client.js';

export interface AppProps {
  client: WsClient;
  api: TuiApi;
}

const FLUSH_MS = 16;
const REDUCED_MOTION = process.env.FRAKTOLE_REDUCED_MOTION === '1';

function patch(task: Task, p: Partial<Task>): Task {
  return { ...task, ...p };
}

export function App({ client, api }: AppProps): JSX.Element {
  const { exit } = useApp();
  const [booted, setBooted] = useState(REDUCED_MOTION);
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('tasks');
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [openGates, setOpenGates] = useState<OpenGate[]>([]);
  const [resolvedGates, setResolvedGates] = useState<Array<{ gateId: string; decision: string }>>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(Date.now());
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [drivers, setDrivers] = useState<DiscoveredDriver[]>([]);
  const [workingRepo, setWorkingRepo] = useState<string | undefined>(undefined);
  const [settings, setSettings] = useState<SettingsState>({
    decompose: true,
    defaultDriver: 'opencode',
  });
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [gateIndex, setGateIndex] = useState(0);
  const [repoBusy, setRepoBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [ticker, setTicker] = useState<string[]>([]);
  const [zoomed, setZoomed] = useState(false);
  const [, setLogTick] = useState(0);

  const logsRef = useRef<Record<string, LogLine[]>>({});
  const pendingRef = useRef<Extract<EventEnvelope, { kind: 'LogChunk' }>[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tasksRef = useRef<Record<string, Task>>({});
  tasksRef.current = tasks;
  const openGatesRef = useRef<OpenGate[]>([]);
  openGatesRef.current = openGates;

  useEffect(() => {
    client.onEvent = handleEvent;
    client.onStateChange = setConnected;
    client.connect();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    void refreshRepos();
    void refreshDrivers();
    return () => {
      clearInterval(tick);
      client.close();
    };
  }, []);

  function flushLogs(): void {
    flushTimer.current = undefined;
    for (const ev of pendingRef.current) {
      const id = ev.taskId!;
      const lines = logsRef.current[id] ?? [];
      lines.push({ ts: ev.ts, stream: ev.payload.stream, text: ev.payload.text });
      logsRef.current[id] = lines;
    }
    pendingRef.current = [];
    setLogTick((n) => n + 1);
  }

  function isLogChunk(ev: EventEnvelope): ev is Extract<EventEnvelope, { kind: 'LogChunk' }> {
    return ev.kind === 'LogChunk';
  }

  function queueLog(ev: EventEnvelope): void {
    if (!isLogChunk(ev)) return;
    pendingRef.current.push(ev);
    if (!flushTimer.current) {
      flushTimer.current = setTimeout(flushLogs, FLUSH_MS);
    }
  }

  function patchTask(m: Record<string, Task>, id: string, p: Partial<Task>): Record<string, Task> {
    const task = m[id];
    if (!task) return m;
    return { ...m, [id]: patch(task, p) };
  }

  function handleEvent(ev: EventEnvelope): void {
    const taskId = ev.taskId;
    setTicker((t) => [`${ev.kind} ${taskId ? taskId.slice(0, 8) : ''}`, ...t].slice(0, 3));
    switch (ev.kind) {
      case 'TaskCreated':
        setTasks((m) => ({ ...m, [ev.payload.task.id]: ev.payload.task }));
        if (selectedId === undefined) setSelectedId(ev.payload.task.id);
        break;
      case 'TaskQueued':
        setTasks((m) => patchTask(m, taskId!, { status: 'queued' }));
        break;
      case 'TaskPlanning':
        setTasks((m) => patchTask(m, taskId!, { status: 'planning' }));
        break;
      case 'TaskRunning':
        setTasks((m) => patchTask(m, taskId!, { status: 'running' }));
        break;
      case 'TaskDone':
        setTasks((m) => patchTask(m, taskId!, { status: 'done' }));
        break;
      case 'TaskFailed':
        setTasks((m) => patchTask(m, taskId!, { status: 'failed' }));
        break;
      case 'TaskCancelled':
        setTasks((m) => patchTask(m, taskId!, { status: 'cancelled' }));
        break;
      case 'MergeStarted':
        setTasks((m) => patchTask(m, taskId!, { status: 'merging' }));
        break;
      case 'MergeConflict':
        setTasks((m) => patchTask(m, taskId!, { status: 'failed' }));
        break;
      case 'GateRequested':
        setOpenGates((g) => [
          ...g,
          {
            gateId: ev.payload.gateId,
            taskId: ev.payload.taskId,
            kind: ev.payload.kind,
            reason: ev.payload.reason,
            branch: ev.payload.branch,
            diffStat: ev.payload.diffStat,
          },
        ]);
        break;
      case 'GateResolved':
        setOpenGates((g) => g.filter((gate) => gate.gateId !== ev.payload.gateId));
        setResolvedGates((r) => [...r, { gateId: ev.payload.gateId, decision: ev.payload.decision }]);
        break;
      case 'LogChunk':
        queueLog(ev);
        break;
      default:
        break;
    }
  }

  function moveSelection(delta: number): void {
    const rows = tileRows();
    if (rows.length === 0) return;
    const idx = rows.indexOf(selectedId ?? '');
    const next = (idx + delta + rows.length) % rows.length;
    setSelectedId(rows[next]);
  }

  /** tiles = active tasks plus the focused task (so finished work stays inspectable) */
  function tileRows(): string[] {
    const active = Object.values(tasksRef.current)
      .filter((t) => ['queued', 'planning', 'running', 'gating', 'merging'].includes(t.status))
      .map((t) => t.id);
    if (selectedId && !active.includes(selectedId)) active.push(selectedId);
    return active;
  }

  async function resolveFirstGate(decision: 'approve' | 'deny'): Promise<void> {
    const gate = openGatesRef.current[0];
    if (!gate) return;
    await api.resolveGate(gate.gateId, decision);
  }

  /** fire-and-forget with errors routed to the notice bar (never crash the TUI) */
  function safe(p: Promise<unknown>, msg: string): void {
    void p.catch((err) => setNotice(`${msg}: ${(err as Error).message}`));
  }

  async function refreshRepos(): Promise<void> {
    try {
      const list = await api.listRepos();
      setRepos(list);
      setWorkingRepo((w) => w ?? list[0]?.path);
    } catch {
      // daemon may be unreachable; the reconnect loop will retry later
    }
  }

  async function refreshDrivers(): Promise<void> {
    try {
      setDrivers(await api.listDrivers());
    } catch {
      // same as above
    }
  }

  async function handleDispatch(goal: string, driver: string, decompose: boolean): Promise<void> {
    setDispatchOpen(false);
    try {
      const repo = workingRepo ?? '';
      const task = await api.createTask({ goal, repoPath: repo, driver, orchestrate: decompose });
      setSelectedId(task.id);
      setActiveTab('tasks');
    } catch (err) {
      setNotice(`dispatch failed: ${(err as Error).message}`);
    }
  }

  const contextKeys = ((): string => {
    switch (activeTab) {
      case 'tasks':
        return '[1-5] tab  [j/k] focus  [z] zoom  [d] dispatch  [x] cancel  [a/n] gate';
      case 'gates':
        return '[1-5] tab  [j/k] select  [a] approve  [n] deny';
      case 'repos':
        return '[1-5] tab  [a] add  [enter] working  [x] remove';
      case 'terminal':
        return '[1-5] tab  [enter] run  [r] rerun  [c] clear  [x] kill';
      case 'settings':
        return '[1-5] tab  [p] decompose  [j/k] driver';
    }
  })();

  useInput((input, key) => {
    if (input === 'q') {
      exit();
      return;
    }
    if (!booted) return;
    if (dispatchOpen) return; // the dispatch box owns the keys
    const tabIdx = '12345'.indexOf(input);
    if (tabIdx >= 0) {
      setActiveTab(TAB_ORDER[tabIdx]!);
      return;
    }
    switch (activeTab) {
      case 'tasks':
        if (input === 'd') {
          setDispatchOpen(true);
          return;
        }
        if (input === 'j') moveSelection(1);
        if (input === 'k') moveSelection(-1);
        if (input === 'z' || key.return) setZoomed((z) => !z);
        if (input === 'x' && selectedId) safe(api.cancel(selectedId), 'cancel failed');
        if (input === 'a' && openGates[0]) safe(resolveFirstGate('approve'), 'approve failed');
        if (input === 'n' && openGates[0]) safe(resolveFirstGate('deny'), 'deny failed');
        break;
      case 'gates':
        if (openGates.length > 0) {
          if (input === 'j') setGateIndex((i) => (i + 1) % openGates.length);
          if (input === 'k') setGateIndex((i) => (i - 1 + openGates.length) % openGates.length);
          if (input === 'a') safe(api.resolveGate(openGates[gateIndex]!.gateId, 'approve'), 'approve failed');
          if (input === 'n') safe(api.resolveGate(openGates[gateIndex]!.gateId, 'deny'), 'deny failed');
        }
        break;
      case 'settings':
        if (input === 'p') setSettings((s) => ({ ...s, decompose: !s.decompose }));
        if (input === 'j' || input === 'k') {
          const installed = drivers.filter((d) => d.installed);
          if (installed.length > 0) {
            const idx = installed.findIndex((d) => d.id === settings.defaultDriver);
            const next = (idx + (input === 'j' ? 1 : -1) + installed.length) % installed.length;
            setSettings((s) => ({ ...s, defaultDriver: installed[next]!.id }));
          }
        }
        break;
      case 'repos':
      case 'terminal':
        // these scenes own their own keys
        break;
    }
    void key;
  });

  if (!booted) {
    return <Boot onDone={() => setBooted(true)} />;
  }

  const selected = selectedId ? tasks[selectedId] : undefined;
  const running = Object.values(tasks).filter((t) => t.status === 'running').length;
  const recent = Object.values(tasks)
    .filter((t) => !t.parentTaskId && ['done', 'failed', 'cancelled'].includes(t.status))
    .map((t) => `${t.status} ${truncate(t.goal, 40)}`);

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <TopBar connected={connected} running={running} openGates={openGates} now={now} notice={notice} ticker={ticker} contextKeys="" />
      <Divider />
      <Box flexDirection="row" flexGrow={1}>
        <Sidebar
          active={activeTab}
          counts={{
            gates: openGates.length,
            repos: repos.length,
            tasks: Object.values(tasks).filter((t) => !t.parentTaskId).length,
          }}
          connected={connected}
          recent={recent}
          now={now}
        />
        <Box flexGrow={1} flexDirection="column" paddingX={1} paddingY={0}>
          <SceneTransition key={activeTab}>
            {activeTab === 'tasks' && (
            <TasksTab
              tasks={tasks}
              tileIds={tileRows()}
              selectedId={selectedId}
              now={now}
              logs={logsRef.current}
              openGates={openGates}
              zoomed={zoomed}
            />
          )}
          {activeTab === 'gates' && (
            <GatesTab gates={openGates} selectedIndex={gateIndex} resolved={resolvedGates} />
          )}
          {activeTab === 'repos' && (
            <ReposTab
              active
              repos={repos}
              workingRepo={workingRepo}
              busy={repoBusy}
              onSetWorking={setWorkingRepo}
              onAdd={async (path) => {
                setRepoBusy(true);
                try {
                  await api.addRepo(path);
                  await refreshRepos();
                } catch (err) {
                  setNotice(`add repo failed: ${(err as Error).message}`);
                } finally {
                  setRepoBusy(false);
                }
              }}
              onRemove={(path) => {
                safe(
                  api.removeRepo(path).then(() => refreshRepos()),
                  'remove repo failed',
                );
              }}
            />
          )}
          {activeTab === 'settings' && (
            <SettingsTab
              settings={settings}
              drivers={drivers}
              connected={connected}
              baseUrl={client.endpoint}
            />
          )}
          {activeTab === 'terminal' && (
            <TerminalTab
              active
              cwd={workingRepo ?? process.cwd()}
              onCommandDone={(dir) => {
                void api
                  .addRepo(dir)
                  .then(() => refreshRepos())
                  .catch(() => {
                    // registration is best-effort (e.g. daemon down)
                  });
              }}
            />
          )}
          {dispatchOpen && (
            <DispatchBox
              open={dispatchOpen}
              repo={workingRepo ?? '(no repo selected)'}
              decompose={settings.decompose}
              drivers={drivers}
              onSubmit={(goal, driver, decompose) => void handleDispatch(goal, driver, decompose)}
              onCancel={() => setDispatchOpen(false)}
            />
          )}
          </SceneTransition>
        </Box>
      </Box>
      <Divider />
      <BottomBar
        connected={connected}
        running={running}
        openGates={openGates}
        now={now}
        notice={notice}
        ticker={ticker}
        contextKeys={contextKeys}
        selectedLine={selected ? `${selected.id.slice(0, 8)} ${selected.status} ${truncate(selected.goal, 30)}` : undefined}
      />
    </Box>
  );
}
