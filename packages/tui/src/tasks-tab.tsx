import { Box, Text, useStdout } from 'ink';
import type { Task } from '@fraktole/core';
import { AgentWindow, type LogLine } from './agent-window.js';
import { GatePrompt, type OpenGate } from './gate-prompt.js';
import { dwindle, type LayoutNode } from './layout.js';
import { COLORS, truncate } from './theme.js';

export interface TasksTabProps {
  tasks: Record<string, Task>;
  tileIds: string[];
  selectedId?: string;
  now: number;
  logs: Record<string, LogLine[]>;
  openGates: OpenGate[];
  zoomed: boolean;
}

const SIDEBAR_W = 24;
const PADDING = 2;

export function TasksTab({
  tasks,
  tileIds,
  selectedId,
  now,
  logs,
  openGates,
  zoomed,
}: TasksTabProps): JSX.Element {
  const { stdout } = useStdout();
  const termW = stdout.columns ?? 100;
  const termH = stdout.rows ?? 30;
  const areaW = Math.max(20, termW - SIDEBAR_W - PADDING);
  const areaH = Math.max(8, termH - 6); // chrome + dividers

  const selected = selectedId ? tasks[selectedId] : undefined;
  const hasPlan = selected?.plan !== undefined && selected.plan.tasks.length > 0;

  if (tileIds.length === 0) {
    return (
      <Box width={areaW} height={areaH} flexDirection="column" alignItems="center" justifyContent="center">
        <Text bold color={COLORS.accent}>
          IDLE
        </Text>
        <Text color={COLORS.muted}> nothing running</Text>
        <Text color={COLORS.dim}> press d to dispatch your first goal</Text>
      </Box>
    );
  }

  const shown = zoomed && selected ? [selected.id] : tileIds;
  const { tree } = dwindle(shown.length, { x: 0, y: 0, width: areaW, height: areaH });

  return (
    <Box flexDirection="column">
      {hasPlan && selected?.plan && (
        <Text color={COLORS.info} wrap="wrap">
          PLAN {truncate(selected.plan.rationale, areaW - 6)} :: {selected.plan.tasks.length} step
          {selected.plan.tasks.length === 1 ? '' : 's'}
        </Text>
      )}
      {openGates[0] && <GatePrompt gate={openGates[0]} />}
      <Box width={areaW} height={areaH} flexDirection="column">
        <TreeNode
          node={tree}
          tasks={tasks}
          shown={shown}
          selectedId={selectedId}
          now={now}
          logs={logs}
        />
      </Box>
    </Box>
  );
}

function TreeNode({
  node,
  tasks,
  shown,
  selectedId,
  now,
  logs,
}: {
  node: LayoutNode;
  tasks: Record<string, Task>;
  shown: string[];
  selectedId?: string;
  now: number;
  logs: Record<string, LogLine[]>;
}): JSX.Element {
  if (node.kind === 'leaf') {
    const task = tasks[shown[node.index]!]!;
    return (
      <AgentWindow
        task={task}
        log={logs[task.id] ?? []}
        now={now}
        focused={task.id === selectedId}
        width={node.rect.width}
        height={node.rect.height}
      />
    );
  }
  return (
    <Box flexDirection={node.dir === 'row' ? 'row' : 'column'} width="100%" height="100%">
      <TreeNode node={node.a} tasks={tasks} shown={shown} selectedId={selectedId} now={now} logs={logs} />
      <TreeNode node={node.b} tasks={tasks} shown={shown} selectedId={selectedId} now={now} logs={logs} />
    </Box>
  );
}
