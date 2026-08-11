import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { COLORS } from './theme.js';
import { Bar } from './primitives.js';

const LINES = ['F R A K T O L E', '', 'one orchestrator for your agents'];
const STEP_MS = 110;

export interface BootProps {
  onDone: () => void;
}

/** staged typographic wordmark reveal before the dashboard settles in */
export function Boot({ onDone }: BootProps): JSX.Element {
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    if (visible >= LINES.length) {
      const t = setTimeout(onDone, 220);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setVisible((v) => v + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [visible, onDone]);

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Bar bg={COLORS.bg} segments={[{ text: ' '.repeat(0) }]} />
      <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
        {LINES.slice(0, visible).map((line, i) => (
          <Text
            key={i}
            bold={i === 0}
            color={i === 0 ? COLORS.accent : COLORS.muted}
          >
            {line}
          </Text>
        ))}
        {visible < LINES.length && <Text color={COLORS.dim}> </Text>}
      </Box>
      <Bar bg={COLORS.bg} segments={[{ text: ' '.repeat(0) }]} />
    </Box>
  );
}
