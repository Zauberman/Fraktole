import type { OpenGate } from './gate-prompt.js';
import { Bar } from './primitives.js';
import { COLORS, connectionWord, fmtClock, truncate } from './theme.js';

export interface ChromeProps {
  connected: boolean;
  running: number;
  openGates: OpenGate[];
  now: number;
  notice?: string;
  ticker: string[];
  contextKeys: string;
  selectedLine?: string;
}

/** full-bleed top command bar: wordmark, connection, live counts, clock */
export function TopBar({ connected, running, openGates, now, notice }: ChromeProps): JSX.Element {
  const left: Array<{ text: string; color?: string; bold?: boolean }> = [
    { text: ' fraktole ', color: COLORS.accent, bold: true },
    { text: connectionWord(connected), color: connected ? COLORS.ok : COLORS.err },
    {
      text: `  ${running} running / ${openGates.length} gate${openGates.length === 1 ? '' : 's'} open`,
      color: COLORS.muted,
    },
  ];
  if (notice) left.push({ text: `  ${notice}`, color: COLORS.err });
  return (
    <Bar
      bg={COLORS.bgRaised}
      segments={left}
      right={[{ text: ` ${fmtClock(now)} `, color: COLORS.dim }]}
    />
  );
}

/** full-bleed bottom status bar: context keys, selection, event ticker */
export function BottomBar({ contextKeys, selectedLine, ticker }: ChromeProps): JSX.Element {
  const tick = ticker[0];
  return (
    <Bar
      bg={COLORS.bgRaised}
      segments={[{ text: ` ${contextKeys}`, color: COLORS.muted }]}
      right={[
        ...(selectedLine ? [{ text: ` ${truncate(selectedLine, 40)} `, color: COLORS.text }] : []),
        ...(tick
          ? [{ text: ` ${tick}`, color: COLORS.dim } as { text: string; color?: string; bold?: boolean }]
          : []),
      ]}
    />
  );
}
