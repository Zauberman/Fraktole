import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { apiFor } from './api.js';
import { WsClient } from './ws-client.js';
import { ensureConfig, defaultConfigPath } from '@fraktole/core';

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--insecure')) {
    // local testing against self-signed certs only
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  const configPath = process.env.FRAKTOLE_CONFIG ?? defaultConfigPath();
  const config = await ensureConfig(configPath);
  const token = process.env.FRAKTOLE_TOKEN ?? config.server.tokens[0];
  if (!token) {
    console.error('[fraktole-tui] no auth token configured');
    process.exit(1);
  }
  const scheme = config.server.tls ? 'https' : 'http';
  const baseUrl = `${scheme}://${config.server.host}:${config.server.port}`;
  const client = new WsClient(baseUrl, token);
  const api = await apiFor();

  // gracious start: if the daemon is not running, boot it (same helper as the CLI)
  const { ensureDaemon } = await import('@fraktole/daemon/spawn-daemon.js');
  await ensureDaemon({
    configPath,
    healthCheck: async () => {
      try {
        const res = await fetch(`${baseUrl}/v1/tasks`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return res.status < 500;
      } catch {
        return false;
      }
    },
  });

  render(<App client={client} api={api} />);
}
