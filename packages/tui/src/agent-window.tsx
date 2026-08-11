import { Box, Text } from 'ink';
import type { Task } from '@fraktole/core';
import { COLORS, STATUS_BADGE_COLORS, STATUS_BADGES, fmtElapsed, fmtStamp, truncate } from './theme.js';
import { useStatusPulse } from './transition.js';

export interface LogLine {
  ts: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface AgentWindowProps {
  task: Task;
  log: LogLine[];
  now: number;
  focused: boolean;
  width: number;
  height: number;
}

const STATUS_SEG = 12;

/**
 * One agent's tile in the tiling layout: a painted header row (status segment
 * + driver/branch/elapsed) over the timestamped stream, fitted to the rect.
 * The header flashes in the status color on transitions; the newest line
 * renders dimmed and brightens as newer output arrives.
 */
export function AgentWindow({ task, log, now, focused, width, height }: AgentWindowProps): JSX.Element {
  const pulsing = useStatusPulse(task.status);
  const bg = pulsing ? STATUS_BADGE_COLORS[task.status] : focused ? COLORS.accent : COLORS.bgRaised;
  const statusColor = pulsing || focused ? COLORS.bg : STATUS_BADGE_COLORS[task.status];
  const metaColor = pulsing || focused ? COLORS.bg : COLORS.muted;
  const meta = ` ${task.driver}  ${truncate(task.branch, 18)}  ${fmtElapsed(task.statusSince, now)} `;
  const bodyHeight = Math.max(0, height - 1);
  const lines = log.slice(-bodyHeight);

  return (
    <Box width={width} height={height} flexDirection="column">
      <Box>
        <Text backgroundColor={bg} color={statusColor} bold>
          {` ${STATUS_BADGES[task.status]} `.padEnd(STATUS_SEG)}
        </Text>
        <Text backgroundColor={bg} color={metaColor} bold>
          {meta.padEnd(Math.max(0, width - STATUS_SEG))}
        </Text>
      </Box>
      {lines.map((line, i) => (
        <Text
          key={i}
          color={line.stream === 'stderr' ? COLORS.warn : i === lines.length - 1 ? COLORS.muted : COLORS.text}
          wrap="wrap"
        >
          {fmtStamp(line.ts)} {line.stream === 'stderr' ? 'ERR' : 'OUT'} {line.text}
        </Text>
      ))}
      {lines.length === 0 && <Text color={COLORS.dim}> waiting for output…</Text>}
    </Box>
  );
}
