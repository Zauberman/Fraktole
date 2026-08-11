import { Box, Text } from 'ink';
import type { OpenGate } from './gate-prompt.js';
import { Divider, Label } from './primitives.js';
import { COLORS, truncate } from './theme.js';

export interface GatesTabProps {
  gates: OpenGate[];
  selectedIndex: number;
  resolved: Array<{ gateId: string; decision: string }>;
}

export function GatesTab({ gates, selectedIndex, resolved }: GatesTabProps): JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Label>Gate Registry</Label>
      <Divider />
      {gates.length === 0 && <Text color={COLORS.dim}> nothing awaiting approval</Text>}
      {gates.map((gate, i) => {
        const selected = i === selectedIndex;
        return (
          <Box key={gate.gateId} flexDirection="column" marginTop={1}>
            <Box>
              <Text inverse={selected} backgroundColor={selected ? COLORS.accent : COLORS.bgRaised} color={selected ? COLORS.bg : COLORS.warn} bold>
                {' '}
                GATE {gate.kind.toUpperCase()}
                {gate.branch ? ` ${gate.branch}` : ''}{' '}
              </Text>
              <Text color={COLORS.dim}> {gate.taskId.slice(0, 8)}</Text>
            </Box>
            <Text color={COLORS.muted} wrap="wrap">
              {'  '}
              {truncate(gate.reason, 96)}
            </Text>
            {gate.diffStat && (
              <Text color={COLORS.info} wrap="wrap">
                {'  '}
                {gate.diffStat.replace(/\n/g, '\n  ')}
              </Text>
            )}
          </Box>
        );
      })}
      {resolved.length > 0 && (
        <Box flexDirection="column" marginTop={2}>
          <Label>Resolved</Label>
          <Divider />
          {resolved.slice(-10).map((r) => (
            <Text key={r.gateId} color={COLORS.dim}>
              {' '}
              {r.decision.toUpperCase()} {r.gateId.slice(0, 8)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
