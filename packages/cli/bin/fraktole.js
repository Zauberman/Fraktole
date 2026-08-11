#!/usr/bin/env node
import 'tsx';
const { runCli } = await import('../src/index.ts');
process.exitCode = await runCli(process.argv.slice(2));
