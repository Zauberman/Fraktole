#!/usr/bin/env node
import 'tsx';
const { main } = await import('../src/index.tsx');
await main();
