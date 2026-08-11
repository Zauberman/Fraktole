import { Box, Text, useStdout } from 'ink';
import type { TaskStatus } from '@fraktole/core';
import { COLORS, STATUS_BADGE_COLORS, STATUS_BADGES } from './theme.js';

/** full terminal width (falls back to 100 when unknown) */
export function useTermWidth(): number {
  const { stdout } = useStdout();
  return stdout.columns ?? 100;
}

export interface Segment {
  text: string;
  color?: string;
  bold?: boolean;
  inverse?: boolean;
}

function renderSegment(seg: Segment, bg: string, key: number): JSX.Element {
  return (
    <Text key={key} backgroundColor={bg} color={seg.color} bold={seg.bold} inverse={seg.inverse}>
      {seg.text}
    </Text>
  );
}

/**
 * A single full-width row painted with a background color (ink 5 has no
 * Box backgroundColor). Content is given as text segments; the row pads to
 * the terminal width. This is how every chrome bar is drawn.
 */
export function Bar({
  bg,
  segments,
  right = [],
}: {
  bg: string;
  segments: Segment[];
  right?: Segment[];
}): JSX.Element {
  const width = useTermWidth();
  const content = segments.reduce((n, s) => n + s.text.length, 0);
  const rightLen = right.reduce((n, s) => n + s.text.length, 0);
  const pad = Math.max(0, width - content - rightLen);
  return (
    <Box>
      {segments.map((s, i) => renderSegment(s, bg, i))}
      <Text backgroundColor={bg}>{' '.repeat(pad)}</Text>
      {right.map((s, i) => renderSegment(s, bg, 100 + i))}
    </Box>
  );
}

/** pre-painted background strip, e.g. to shade the scene canvas */
export function Backdrop({ bg, height = 1 }: { bg: string; height?: number }): JSX.Element {
  const width = useTermWidth();
  return (
    <Box flexDirection="column">
      {Array.from({ length: height }, (_, i) => (
        <Text key={i} backgroundColor={bg}>
          {' '.repeat(width)}
        </Text>
      ))}
    </Box>
  );
}

/** full-width typographic hairline */
export function Divider({ color = COLORS.border }: { color?: string }): JSX.Element {
  const width = useTermWidth();
  return <Text color={color}>{'─'.repeat(width)}</Text>;
}

/** uppercase micro-label with tracking (spaced capitals) */
export function Label({ children, color = COLORS.muted }: { children: string; color?: string }): JSX.Element {
  return (
    <Text color={color} bold>
      {' '}
      {children.toUpperCase()}{' '}
    </Text>
  );
}

/** padded typographic status badge: RUN  (no brackets, no icons) */
export function Badge({ status }: { status: TaskStatus }): JSX.Element {
  const color = STATUS_BADGE_COLORS[status];
  return (
    <Text inverse color={color}>
      {' '}
      {STATUS_BADGES[status]}{' '}
    </Text>
  );
}

/** dim micro copy */
export function Micro({ children }: { children: string }): JSX.Element {
  return <Text color={COLORS.dim}>{children}</Text>;
}
