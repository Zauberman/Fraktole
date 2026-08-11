import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { TextInput } from './input.js';
import { runCommand, type TerminalProcess } from './terminal-runner.js';
import { COLORS, truncate } from './theme.js';

export interface TerminalTabProps {
  active: boolean;
  cwd: string;
  onCommandDone: (cwd: string) => void;
}

const MAX_LINES = 500;

export function TerminalTab({ active, cwd, onCommandDone }: TerminalTabProps): JSX.Element {
  const [command, setCommand] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [lastExit, setLastExit] = useState<number | null | undefined>(undefined);
  const procRef = useRef<TerminalProcess | undefined>(undefined);
  const lastCommandRef = useRef('');

  function appendOutput(text: string): void {
    setLines((prev) => {
      const next = [...prev, ...text.split('\n')];
      return next.slice(-MAX_LINES);
    });
  }

  async function submit(value: string): Promise<void> {
    if (!value.trim() || running) return;
    lastCommandRef.current = value;
    setCommand('');
    setRunning(true);
    setLastExit(undefined);
    appendOutput(`$ ${value}`);
    const proc = runCommand({ cwd, command: value, onOutput: appendOutput });
    procRef.current = proc;
    const { code } = await proc.exited;
    procRef.current = undefined;
    setRunning(false);
    setLastExit(code);
    onCommandDone(cwd);
  }

  useInput(
    (input) => {
      if (running && input === 'x') {
        procRef.current?.kill();
        return;
      }
      if (input === 'c') {
        setLines([]);
        return;
      }
      if (input === 'r' && lastCommandRef.current && !running) {
        void submit(lastCommandRef.current);
        return;
      }
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold color={COLORS.muted}>
        {' '}
        TERMINAL - cwd {truncate(cwd, 40)}
      </Text>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {lines.length === 0 && <Text color={COLORS.muted}> (run any command - for example: opencode run "add a TODO")</Text>}
        {lines.map((line, i) => (
          <Text key={i} wrap="wrap">
            {line}
          </Text>
        ))}
      </Box>
      <Box>
        <Text color={COLORS.accent}>
          {running ? '[RUN] ' : '[$] '}
        </Text>
        <TextInput
          focus={active}
          value={command}
          onChange={setCommand}
          onSubmit={(value) => void submit(value)}
        />
      </Box>
      <Text color={COLORS.muted} wrap="wrap">
        {running
          ? '[x] kill'
          : lastExit === undefined
            ? '[enter] run   [r] rerun   [c] clear'
            : `[enter] run   [r] rerun   [c] clear   last exit: ${lastExit}`}
      </Text>
    </Box>
  );
}
