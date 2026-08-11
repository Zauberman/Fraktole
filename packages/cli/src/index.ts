import { parseArgs } from 'node:util';
import { defaultConfigPath } from '@fraktole/core';
import { ApiError, CliError, loadContext } from './client.js';
import {
  cmdCancel,
  cmdConfigPath,
  cmdDispatch,
  cmdGates,
  cmdLogs,
  cmdPair,
  cmdStart,
  cmdStatus,
} from './commands.js';

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  repo: { type: 'string' },
  driver: { type: 'string' },
  'base-branch': { type: 'string' },
  json: { type: 'boolean' },
  follow: { type: 'boolean', short: 'f' },
  insecure: { type: 'boolean' },
} as const;

function usage(): string {
  return `fraktole - coding agent orchestrator

usage:
  fraktole start
  fraktole dispatch <goal> [--repo <path>] [--driver <id>] [--base-branch <name>]
  fraktole status [--json]
  fraktole logs <taskId> [--follow]
  fraktole gates list | gates approve <gateId> | gates deny <gateId>
  fraktole cancel <taskId>
  fraktole pair | pair revoke <deviceId>
  fraktole config path
  fraktole --help

  --insecure   accept self-signed TLS certificates (local testing only)`;
}

export async function runCli(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    console.error(`fraktole: ${(err as Error).message}`);
    console.error(usage());
    return 2;
  }
  const [command, arg1, arg2] = parsed.positionals;
  if (parsed.values.help) {
    console.log(usage());
    return 0;
  }
  if (!command) {
    console.error(usage());
    return 2;
  }
  if (parsed.values.insecure) {
    // local testing against self-signed certs only
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  try {
    switch (command) {
      case 'start':
        await cmdStart(arg1);
        return 0;
      case 'dispatch': {
        if (!arg1) {
          throw new CliError('dispatch requires a goal');
        }
        const ctx = await loadContext();
        await cmdDispatch(ctx, arg1, {
          repo: parsed.values.repo,
          driver: parsed.values.driver,
          baseBranch: parsed.values['base-branch'],
        });
        return 0;
      }
      case 'status': {
        const ctx = await loadContext();
        await cmdStatus(ctx, parsed.values.json === true);
        return 0;
      }
      case 'logs': {
        if (!arg1) throw new CliError('logs requires a taskId');
        const ctx = await loadContext();
        await cmdLogs(ctx, arg1, { follow: parsed.values.follow === true });
        return 0;
      }
      case 'gates': {
        const ctx = await loadContext();
        await cmdGates(ctx, arg1 ?? 'list', arg2);
        return 0;
      }
      case 'cancel': {
        if (!arg1) throw new CliError('cancel requires a taskId');
        const ctx = await loadContext();
        await cmdCancel(ctx, arg1);
        return 0;
      }
      case 'config':
        if (arg1 === 'path') {
          await cmdConfigPath();
          return 0;
        }
        throw new CliError('usage: fraktole config path');
      case 'pair': {
        const ctx = await loadContext();
        await cmdPair(ctx, arg1, arg2);
        return 0;
      }
      default:
        throw new CliError(`unknown command: ${command}`);
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`fraktole: ${err.message} (HTTP ${err.status})`);
    } else if (err instanceof Error) {
      console.error(`fraktole: ${err.message}`);
    }
    console.error(usage());
    return err instanceof CliError ? 2 : 1;
  }
}

export { defaultConfigPath };
