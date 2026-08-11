#!/usr/bin/env node
import 'tsx';
const { main } = await import('../src/index.ts');
await main();
