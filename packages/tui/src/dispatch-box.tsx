import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { DiscoveredDriver } from './api.js';
import { TextInput } from './input.js';
import { COLORS, truncate } from './theme.js';

export interface DispatchBoxProps {
  open: boolean;
  repo: string;
  decompose: boolean;
  drivers: DiscoveredDriver[];
  onSubmit: (goal: string, driver: string, decompose: boolean) => void;
  onCancel: () => void;
}

export function DispatchBox({
  open,
  repo,
  decompose,
  drivers,
  onSubmit,
  onCancel,
}: DispatchBoxProps): JSX.Element {
  const [goal, setGoal] = useState('');
  const [editingGoal, setEditingGoal] = useState(true);
  const installed = drivers.filter((d) => d.installed);
  const [driverIndex, setDriverIndex] = useState(
    Math.max(0, installed.findIndex((d) => d.id === 'opencode')),
  );
  const [useDecompose, setUseDecompose] = useState(decompose);

  const driver = installed[driverIndex]?.id ?? installed[0]?.id;

  useInput(
    (input, key) => {
      if (editingGoal) return; // TextInput owns the keys while typing the goal
      if (key.tab || input === '\t') {
        setEditingGoal(true);
        return;
      }
      if (input === 'j') setDriverIndex((i) => (i + 1) % Math.max(1, installed.length));
      if (input === 'k') setDriverIndex((i) => (i - 1 + installed.length) % Math.max(1, installed.length));
      if (input === 'p') setUseDecompose((v) => !v);
      if (key.return || input === '\r') {
        if (driver && goal.trim()) onSubmit(goal.trim(), driver, useDecompose);
      }
      if (key.escape) onCancel();
    },
    { isActive: open && !editingGoal },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLORS.accent} paddingX={2} paddingY={1}>
      <Text bold color={COLORS.accent}>
        DISPATCH
      </Text>
      <Text color={COLORS.muted}> repo: {truncate(repo, 60)}</Text>
      {editingGoal ? (
        <Box>
          <Text color={COLORS.muted}>goal: </Text>
          <TextInput
            focus={editingGoal}
            value={goal}
            onChange={setGoal}
            onSubmit={(value) => {
              if (driver && value.trim()) onSubmit(value.trim(), driver, useDecompose);
            }}
            onCancel={onCancel}
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box>
            <Text color={COLORS.muted}>driver: </Text>
            {installed.length === 0 && <Text color={COLORS.err}>(none installed)</Text>}
            {installed.map((d) => (
              <Text key={d.id} inverse={d.id === driver} color={d.id === driver ? COLORS.accent : COLORS.text}>
                {' '}
                {d.id}{' '}
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color={COLORS.muted}>decompose: </Text>
            <Text inverse={useDecompose} color={useDecompose ? COLORS.accent : COLORS.err}>
              {' '}
              {useDecompose ? 'ON' : 'OFF'}{' '}
            </Text>
          </Box>
        </Box>
      )}
      <Text color={COLORS.muted} wrap="wrap">
        {editingGoal
          ? '[tab] options   [enter] dispatch   [esc] cancel'
          : '[j/k] driver   [p] decompose   [tab] goal   [enter] dispatch   [esc] cancel'}
      </Text>
    </Box>
  );
}
