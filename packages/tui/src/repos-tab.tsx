import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { RepoConfig } from '@fraktole/core';
import { TextInput } from './input.js';
import { COLORS, truncate } from './theme.js';

export interface ReposTabProps {
  active: boolean;
  repos: RepoConfig[];
  workingRepo?: string;
  busy: boolean;
  onSetWorking: (path: string) => void;
  onAdd: (path: string) => Promise<void>;
  onRemove: (path: string) => void;
}

export function ReposTab({
  active,
  repos,
  workingRepo,
  busy,
  onSetWorking,
  onAdd,
  onRemove,
}: ReposTabProps): JSX.Element {
  const [index, setIndex] = useState(0);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const selected = repos[index];

  useInput(
    (input, key) => {
      if (adding) return; // TextInput owns the keys while typing a path
      if (input === 'a') {
        setAdding(true);
        return;
      }
      if (input === 'j' && repos.length > 0) setIndex((i) => (i + 1) % repos.length);
      if (input === 'k' && repos.length > 0) setIndex((i) => (i - 1 + repos.length) % repos.length);
      if (key.return && selected) onSetWorking(selected.path);
      if (input === 'x' && selected) onRemove(selected.path);
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Text bold color={COLORS.muted}>
        {' '}
        REPOS ({repos.length})
      </Text>
      {repos.length === 0 && <Text color={COLORS.muted}> (none registered - press a to add)</Text>}
      {repos.map((repo, i) => {
        const working = repo.path === workingRepo;
        const selectedRow = i === index;
        return (
          <Box key={repo.path}>
            <Text inverse={selectedRow} color={working ? COLORS.accent : undefined}>
              {' '}
              {working ? 'WORKING ' : '        '}
            </Text>
            <Text inverse={selectedRow}> {truncate(repo.path, 60)}</Text>
          </Box>
        );
      })}
      {adding && (
        <Box marginTop={1}>
          <Text color={COLORS.muted}>path: </Text>
          <TextInput
            focus={adding}
            value={path}
            onChange={setPath}
            onSubmit={async (value) => {
              setAdding(false);
              setPath('');
              await onAdd(value);
            }}
            onCancel={() => {
              setAdding(false);
              setPath('');
            }}
          />
        </Box>
      )}
      <Text color={COLORS.muted} wrap="wrap">
        {busy ? ' syncing...' : '[a] add   [j/k] select   [enter] set working   [x] remove'}
      </Text>
    </Box>
  );
}
