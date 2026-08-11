import { Text, useInput } from 'ink';
import { useState } from 'react';
import { COLORS } from './theme.js';

export interface TextInputProps {
  focus: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
  placeholder?: string;
}

/**
 * Minimal single-line input for ink 5 (which dropped TextInput): printable
 * characters append, backspace deletes, enter submits, escape cancels.
 */
export function TextInput({
  focus,
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
}: TextInputProps): JSX.Element {
  const [cursor] = useState(0);
  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.backspace) {
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        return;
      }
      if (input.length > 0) {
        onChange(value.slice(0, cursor) + input + value.slice(cursor));
      }
    },
    { isActive: focus },
  );
  return (
    <Text color={COLORS.text}>
      {value.length > 0 ? value : <Text color={COLORS.muted}>{placeholder ?? ''}</Text>}
    </Text>
  );
}
