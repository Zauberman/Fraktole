/** Autonomous-mode prompt plugins ("Auto compose"). Each variant appends an
 *  AUTONOMOUS MODE section to the system prompt: a mission, the research-
 *  propose-fix-compact loop, and the self-goaling authority for the run.
 *  The variant list and names live in src/shared/autonomy.ts (the renderer
 *  popover consumes the same constants); this module holds the main-process
 *  prompt content.
 */

import { CUSTOM_PLACEHOLDER, type AutonomyVariant } from '../src/shared/autonomy.js';

export type { AutonomyVariant } from '../src/shared/autonomy.js';
export { AUTONOMY_NAMES, AUTONOMY_VARIANTS, CUSTOM_PLACEHOLDER } from '../src/shared/autonomy.js';

/** The goal armed automatically when a variant is picked. The custom
 *  variant's goal is derived from its saved name at startAutonomy time;
 *  this entry is the fallback. */
export const AUTONOMY_MISSIONS: Record<AutonomyVariant, string> = {
  cyber: 'Autonomous cybersecurity audit: find and fix vulnerabilities in the project fork.',
  frontend: 'Autonomous frontend rework: find and implement meaningful visual, UX and performance improvements in the project fork.',
  bugs: 'Autonomous bug hunt: find and fix real bugs in the project fork.',
  feature: 'Autonomous feature work: improve existing features and add a small set of high-value additions in the project fork.',
  tests: 'Autonomous test suite improvement: strengthen the test suite and its drivers in the project fork.',
  readability: 'Autonomous readability and scalability pass: reorganize the project for clarity and growth without breaking any logic.',
  custom: 'Autonomous custom run.',
};

export const AUTONOMY_PLUGINS: Record<AutonomyVariant, string> = {
  cyber: [
    'AUTONOMOUS MODE: CYBER',
    '- Work happens exclusively in the project fork (path announced at kick-off); the original project is never touched.',
    '- Spawn the read-only plan agent harness (opencode, or any other preferred by the user harness) inside the fork as research counsel. Dispatch it to hunt cybersecurity issues: injection, auth flaws, secret leakage, unsafe dependencies, insecure defaults — findings ranked by impact with fix plans.',
    '- For each meaningful finding: renew the goal via set_goal, dispatch build agents to implement, verify with read_tile and search_files before accepting.',
    '- After every fix round, /compact the read-only agent (type_into_tile /compact) and ask for the next round of findings.',
    '- Iterate until the read-only agent proposes nothing meaningful. Then clear the goal (set_goal empty), write your final verdict and stop.',
    '- You set and clear goals yourself for this run. Spawns default to the remembered launcher; ask_user auto-resolves — decide yourself.',
  ].join('\n'),
  frontend: [
    'AUTONOMOUS MODE: FRONTEND',
    '- Work happens exclusively in the project fork (path announced at kick-off); the original project is never touched.',
    '- Spawn the read-only plan agent harness (opencode, or any other preferred by the user harness) inside the fork as research counsel. Dispatch it to find meaningful frontend reworks and improvements: visual polish, layout and responsiveness, accessibility, performance, UX flows — ranked by impact with fix plans. Be strict: great frontend, not passable frontend.Also keep the typographic vibrant approach when prompting the read only agent : no live entity icons anywhere.',
    '- For each meaningful proposal: renew the goal via set_goal, dispatch build agents to implement, verify with read_tile and read_test_page (console errors, loading) before accepting.',
    '- After every fix round, /compact the read-only agent (type_into_tile /compact) and ask for the next round of proposals.',
    '- Iterate until the read-only agent proposes nothing meaningful. Then clear the goal (set_goal empty), write your final verdict and stop.',
    '- You set and clear goals yourself for this run. Spawns default to the remembered launcher; ask_user auto-resolves — decide yourself.',
  ].join('\n'),
  bugs: [
    'AUTONOMOUS MODE: BUGS',
    '- Work happens exclusively in the project fork (path announced at kick-off); the original project is never touched.',
    '- Spawn the read-only plan agent harness (opencode, or any other preferred by the user harness) inside the fork as research counsel. Dispatch it to find real bugs: crashes, wrong behavior, edge cases, race conditions, error paths — ranked by severity with reproductions and fixes.',
    '- For each meaningful finding: renew the goal via set_goal, dispatch build agents to implement, verify with read_tile and read_test_page before accepting.',
    '- After every fix round, /compact the read-only agent (type_into_tile /compact) and ask for the next round of findings.',
    '- Iterate until the read-only agent proposes nothing meaningful. Then clear the goal (set_goal empty), write your final verdict and stop.',
    '- You set and clear goals yourself for this run. Spawns default to the remembered launcher; ask_user auto-resolves — decide yourself.',
  ].join('\n'),
  feature: [
    'AUTONOMOUS MODE: FEATURES',
    '- Work happens exclusively in the project fork (path announced at kick-off); the original project is never touched.',
    '- Spawn the read-only  agent harness (opencode, or any other preferred by the user harness) inside the fork as research counsel. Dispatch it to audit existing features and propose meaningful improvements, plus a small set of high-value additions: UX gaps, missing affordances, performance wins, edge cases — ranked by value with concrete fix plans. Be strict: ship great features, not noise.',
    '- For each meaningful proposal: renew the goal via set_goal, dispatch build agents to implement, verify with read_tile, search_files and read_test_page (console errors, loading) before accepting.',
    '- After every round, /compact the read-only agent (type_into_tile /compact) and ask for the next round of proposals.',
    '- Iterate until the read-only agent proposes nothing meaningful. Then clear the goal (set_goal empty), write your final verdict and stop.',
    '- You set and clear goals yourself for this run. Spawns default to the remembered launcher; ask_user auto-resolves — decide yourself.',
  ].join('\n'),
  tests: [
    'AUTONOMOUS MODE: TESTS',
    '- Work happens exclusively in the project fork (path announced at kick-off); the original project is never touched.',
    '- Spawn the read-only  agent harness (opencode, or any other preferred by the user harness) inside the fork as research counsel. Dispatch it to audit the test suite and its drivers: weak coverage, flaky tests, missing edge cases, dead or duplicate tests — ranked by impact with concrete fix plans.',
    '- For each meaningful finding: renew the goal via set_goal, dispatch build agents to implement, then have the responsible agent RUN the suite (npm test / npx vitest run) and report failures before you accept.',
    '- After every round, /compact the read-only agent (type_into_tile /compact) and ask for the next round of findings.',
    '- Iterate until the read-only agent proposes nothing meaningful. Then clear the goal (set_goal empty), write your final verdict and stop.',
    '- You set and clear goals yourself for this run. Spawns default to the remembered launcher; ask_user auto-resolves — decide yourself.',
  ].join('\n'),
  readability: [
    'AUTONOMOUS MODE: READABILITY',
    '- Work happens exclusively in the project fork (path announced at kick-off); the original project is never touched.',
    '- Spawn the read-only plan agent harness (opencode, or any other preferred by the user harness) inside the fork as research counsel. Dispatch it to audit structure and naming: monolithic files, unclear module boundaries, dead code, duplication, hardcoded values, tangled dependencies — ranked by clarity and scalability gain, each with a plan that PRESERVES behavior exactly.',
    '- For each meaningful proposal: renew the goal via set_goal, dispatch build agents to implement, then have the responsible agent RUN the suite (npm test / npx vitest run) and report failures before you accept — no logic may change.',
    '- After every round, /compact the read-only agent (type_into_tile /compact) and ask for the next round of proposals.',
    '- Iterate until the read-only agent proposes nothing meaningful. Then clear the goal (set_goal empty), write your final verdict and stop.',
    '- You set and clear goals yourself for this run. Spawns default to the remembered launcher; ask_user auto-resolves — decide yourself.',
  ].join('\n'),
  custom: CUSTOM_PLACEHOLDER,
};
