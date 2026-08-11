import { readFileSync } from 'node:fs';
import type { TlsConfig } from '@fraktole/core';

export function loadTlsOptions(cfg: TlsConfig): { key: string; cert: string } {
  return {
    key: readFileSync(cfg.key, 'utf8'),
    cert: readFileSync(cfg.cert, 'utf8'),
  };
}
