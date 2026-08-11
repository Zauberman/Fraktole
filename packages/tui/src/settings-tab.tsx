import { Box, Text } from 'ink';
import type { DiscoveredDriver } from './api.js';
import { COLORS } from './theme.js';

export interface SettingsState {
  decompose: boolean;
  defaultDriver: string;
}

export interface SettingsTabProps {
  settings: SettingsState;
  drivers: DiscoveredDriver[];
  connected: boolean;
  baseUrl: string;
}

export function SettingsTab({ settings, drivers, connected, baseUrl }: SettingsTabProps): JSX.Element {
  const installed = drivers.filter((d) => d.installed);
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold color={COLORS.muted}>
        {' '}
        SETTINGS
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={COLORS.muted}> planner decomposition</Text>
        <Text inverse={settings.decompose} color={settings.decompose ? COLORS.accent : COLORS.err}>
          {' '}
          {settings.decompose ? 'ON - goals decompose into parallel agents' : 'OFF - every goal runs as one agent'}{' '}
        </Text>
        <Text color={COLORS.muted}> [p] toggle</Text>
      </Box>

      <Box marginTop={2} flexDirection="column">
        <Text color={COLORS.muted}> default agent driver</Text>
        {installed.length === 0 && <Text color={COLORS.err}> (no agent CLIs found on PATH)</Text>}
        {installed.map((d) => (
          <Text
            key={d.id}
            inverse={d.id === settings.defaultDriver}
            color={d.id === settings.defaultDriver ? COLORS.accent : COLORS.text}
          >
            {' '}
            {d.id} ({d.command}){' '}
          </Text>
        ))}
        <Text color={COLORS.muted}> [j/k] select</Text>
      </Box>

      <Box marginTop={2} flexDirection="column">
        <Text color={COLORS.muted}> connection</Text>
        <Text color={connected ? COLORS.ok : COLORS.err}>
          {' '}
          {connected ? 'CONNECTED' : 'connecting'} to {baseUrl}
        </Text>
      </Box>
    </Box>
  );
}
