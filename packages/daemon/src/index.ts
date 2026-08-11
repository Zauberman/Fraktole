import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultConfigPath,
  ensureConfig,
  type EventEnvelope,
  type FraktoleConfig,
} from '@fraktole/core';
import { claudeDriver } from './drivers/claude.js';
import { discoverDrivers, type DiscoveredDriver } from './drivers/discovery.js';
import { opencodeDriver } from './drivers/opencode.js';
import { pluginDriver } from './drivers/plugin.js';
import { DriverRegistry } from './drivers/index.js';
import { EventBus } from './event-bus.js';
import { GateManager } from './gates.js';
import { PairingStore } from './pairing.js';
import { Persistence } from './persistence.js';
import { createPlanner, type Planner } from './planner/index.js';
import { RepoRegistry } from './repos.js';
import { AgentRunner } from './runner.js';
import { createFraktoleServer } from './server.js';
import { TaskEngine, type TaskHandlers } from './task-engine.js';
import { WorktreeManager, isGitRepo } from './worktrees.js';

export const VERSION = '0.1.0';

export function daemonHandlers(deps: {
  worktrees: WorktreeManager;
  runner: AgentRunner;
  planner: Planner;
  gates: GateManager;
  bus: EventBus;
}): TaskHandlers {
  return {
    plan: async (task) => {
      if (!task.orchestrate) {
        return { tasks: [], rationale: 'direct task' };
      }
      // decomposition needs git worktrees; a plain directory runs as a single agent
      if (!(await isGitRepo(task.repoPath))) {
        deps.bus.publish('LogChunk', task.id, {
          taskId: task.id,
          stream: 'stderr',
          text: '[fraktole] target is not a git repo — running the goal directly\n',
        });
        return { tasks: [], rationale: 'direct fallback (no git)' };
      }
      try {
        return await deps.planner.planTask(task.goal, {
          repoPath: task.repoPath,
          defaultBranch: task.baseBranch,
          cwd: task.repoPath,
        });
      } catch (err) {
        // gracious fallback: the core loop must never die because the planner did
        deps.bus.publish('LogChunk', task.id, {
          taskId: task.id,
          stream: 'stderr',
          text: `[fraktole] planner unavailable (${messageOf(err)}) — running the goal directly\n`,
        });
        return { tasks: [], rationale: 'direct fallback' };
      }
    },
    run: async (task) => {
      if (await isGitRepo(task.repoPath)) {
        const worktreePath = await deps.worktrees.createWorktree(
          task.repoPath,
          task.id,
          task.baseBranch,
        );
        task.worktreePath = worktreePath;
      } else {
        // bare mode: the agent works in the directory itself, no merge possible
        task.bare = true;
        task.worktreePath = task.repoPath;
      }
      await deps.runner.run(task);
      await deps.gates.requestMergeGate(task);
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface EngineRef {
  current: TaskEngine | null;
}

export function buildDaemon(
  config: FraktoleConfig,
  bus: EventBus,
): { handlers: TaskHandlers; gates: GateManager; engineRef: EngineRef; driverEntries: Array<{ id: string; command: string }> } {
  const engineRef: EngineRef = { current: null };
  const worktrees = new WorktreeManager({ worktreesDir: join(config.dataDir, 'worktrees') });
  const registry = new DriverRegistry();
  const driverEntries: Array<{ id: string; command: string }> = [];
  if (config.agents.opencode?.enabled !== false) {
    registry.register(opencodeDriver);
    driverEntries.push({ id: 'opencode', command: 'opencode' });
  }
  if (config.agents.claude?.enabled === true) {
    registry.register(claudeDriver);
    driverEntries.push({ id: 'claude', command: 'claude' });
  }
  for (const plugin of config.agents.plugins) {
    registry.register(pluginDriver(plugin));
    driverEntries.push({ id: plugin.id, command: plugin.command });
  }
  const gates = new GateManager({ worktrees, bus, policy: config.gates });
  const runner = new AgentRunner({
    bus,
    registry,
    defaultTimeoutMs: config.limits.defaultTimeoutMs,
    onAgentGate: (taskId, reason) => {
      const engine = engineRef.current;
      const task = engine?.getTask(taskId);
      if (task) gates.agentGate(task, reason);
    },
  });
  const handlers = daemonHandlers({ worktrees, runner, planner: createPlanner(config.planner), gates, bus });
  return { handlers, gates, engineRef, driverEntries };
}

export interface Daemon {
  config: FraktoleConfig;
  configPath: string;
  bus: EventBus;
  persist: Persistence;
  engine: TaskEngine;
  pairing: PairingStore;
  drivers: DiscoveredDriver[];
  repos: RepoRegistry;
}

export async function runDaemon(
  configPath?: string,
  handlers?: TaskHandlers,
): Promise<Daemon> {
  const path = configPath ?? defaultConfigPath();
  const config = await ensureConfig(path);
  await mkdir(config.dataDir, { recursive: true });
  const persist = new Persistence(config.dataDir);
  const pairing = new PairingStore(join(config.dataDir, 'devices.jsonl'));
  await pairing.load();
  const repos = new RepoRegistry(path, config);
  const bus = new EventBus();
  const built = handlers ? undefined : buildDaemon(config, bus);
  const drivers = built ? await discoverDrivers(built.driverEntries) : [];
  const engine = new TaskEngine({
    bus,
    handlers: handlers ?? built!.handlers,
    limits: config.limits,
  });
  if (built) {
    built.engineRef.current = engine;
    built.gates.attachEngine(engine);
  }

  bus.onPublish = (ev: EventEnvelope) => {
    void persist.append(ev.taskId ?? '_system', ev);
    if (ev.seq > 0 && ev.seq % 200 === 0) {
      void persist.snapshot(engine.getState());
    }
  };

  const restored = await persist.restore();
  engine.restore(restored);
  bus.publish('StateRestored', undefined, {
    taskCount: Object.keys(restored.tasks).length,
    lastSeq: restored.lastSeq,
  });
  bus.publish('DaemonStarted', undefined, { version: VERSION, pid: process.pid });
  await writeFile(join(config.dataDir, 'daemon.pid'), `${process.pid}\n`, 'utf8');

  return { config, configPath: path, bus, persist, engine, pairing, drivers, repos };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;

export async function main(): Promise<void> {
  const { config, bus, persist, engine, pairing, drivers, repos } = await runDaemon();
  const server = createFraktoleServer({
    engine,
    bus,
    tokens: config.server.tokens,
    pairing,
    tls: config.server.tls,
    drivers,
    decomposeDefault: config.planner.decompose ?? true,
    repos,
  });
  const scheme = config.server.tls ? 'https' : 'http';
  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[fraktole] ${signal}: snapshotting and exiting`);
    await persist.snapshot(engine.getState());
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await new Promise<void>((resolve) => {
    server.listen(config.server.port, config.server.host, () => resolve());
  });
  console.error(
    `[fraktole] daemon started (pid ${process.pid}, data ${config.dataDir}, api ${scheme}://${config.server.host}:${config.server.port})`,
  );
}

if (isMain) {
  void main().catch((err) => {
    console.error(`[fraktole] daemon failed to start: ${String(err)}`);
    process.exit(1);
  });
}
