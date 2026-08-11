// Unified `fraktole` entry: no arguments opens the TUI, subcommands run the CLI.
import { main as tuiMain } from '@fraktole/tui';
import { runCli } from './index.js';

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === undefined || cmd === 'tui') {
    await tuiMain(rest);
  } else {
    process.exitCode = await runCli(process.argv.slice(2));
  }
}

void main().catch((err) => {
  console.error(`fraktole: ${String(err)}`);
  process.exit(1);
});
