import { Box, Text } from 'ink';
import { COLORS, truncate } from './theme.js';

export interface OpenGate {
  gateId: string;
  taskId: string;
  kind: string;
  reason: string;
  branch?: string;
  diffStat?: string;
}

export interface GatePromptProps {
  gate: OpenGate;
}

/** approval block: painted accent header, reason, actions — the one emphatic moment */
export function GatePrompt({ gate }: GatePromptProps): JSX.Element {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Text backgroundColor={COLORS.warn} color={COLORS.bg} bold>
        {' '}
        APPROVAL REQUIRED{' '}
      </Text>
      <Text color={COLORS.text}>
        {' '}
        {gate.taskId.slice(0, 8)} :: {gate.kind.toUpperCase()}
        {gate.branch ? ` :: ${gate.branch}` : ''}
      </Text>
      <Text color={COLORS.muted} wrap="wrap">
        {' '}
        {truncate(gate.reason, 100)}
      </Text>
      <Text color={COLORS.dim}>
        {' '}
        [a] approve   [n] deny
      </Text>
    </Box>
  );
}
