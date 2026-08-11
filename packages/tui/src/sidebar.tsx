import { Box, Text } from 'ink';
import { COLORS, connectionWord, truncate } from './theme.js';
import { Divider, Micro } from './primitives.js';

export type TabId = 'tasks' | 'gates' | 'repos' | 'terminal' | 'settings';

export const TAB_ORDER: TabId[] = ['tasks', 'gates', 'repos', 'terminal', 'settings'];

const TAB_LABELS: Record<TabId, string> = {
  tasks: 'TASKS',
  gates: 'GATES',
  repos: 'REPOS',
  terminal: 'TERMINAL',
  settings: 'SETTINGS',
};

export interface SidebarProps {
  active: TabId;
  counts?: Partial<Record<TabId, number>>;
  connected: boolean;
  recent: string[];
  now: number;
}

const WIDTH = 24;

/** one painted sidebar row (ink 5 has no Box backgroundColor) */
function Row({
  text,
  color = COLORS.muted,
  bold = false,
  inverse = false,
}: {
  text: string;
  color?: string;
  bold?: boolean;
  inverse?: boolean;
}): JSX.Element {
  return (
    <Text backgroundColor={COLORS.bgRaised} color={color} bold={bold} inverse={inverse}>
      {text.padEnd(WIDTH)}
    </Text>
  );
}

export function Sidebar({ active, counts, connected, recent, now }: SidebarProps): JSX.Element {
  return (
    <Box width={WIDTH} flexDirection="column">
      <Row text="fraktole" color={COLORS.accent} bold />
      <Row
        text={`${connectionWord(connected)} ${new Date(now).toLocaleTimeString([], { hour12: false })}`}
        color={COLORS.dim}
      />
      <Divider />
      {TAB_ORDER.map((id, i) => {
        const selected = id === active;
        const count = counts?.[id] ?? 0;
        return (
          <Row
            key={id}
            text={`${i + 1} ${TAB_LABELS[id]}${count > 0 ? ` ${count}` : ''}`}
            color={selected ? COLORS.accent : COLORS.muted}
            bold={selected}
            inverse={selected}
          />
        );
      })}
      <Divider />
      <Row text="RECENT" color={COLORS.dim} />
      {recent.length === 0 && <Micro>{'  (none)'.padEnd(WIDTH)}</Micro>}
      {recent.slice(-6).map((line) => (
        <Micro key={line}>{`  ${truncate(line, WIDTH - 4)}`.padEnd(WIDTH)}</Micro>
      ))}
    </Box>
  );
}
