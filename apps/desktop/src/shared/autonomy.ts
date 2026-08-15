/** Shared autonomous-mode variant definitions. Lives in src/shared so the
 *  main process (prompt building) and the renderer (auto compose popover)
 *  consume the SAME list — the popover can never drift from the harness.
 */

export type AutonomyVariant =
  | 'cyber'
  | 'frontend'
  | 'bugs'
  | 'feature'
  | 'tests'
  | 'readability'
  | 'custom';

export const AUTONOMY_VARIANTS: readonly AutonomyVariant[] = [
  'cyber',
  'frontend',
  'bugs',
  'feature',
  'tests',
  'readability',
  'custom',
];

export const AUTONOMY_NAMES: Record<AutonomyVariant, string> = {
  cyber: 'Cyber',
  frontend: 'Frontend',
  bugs: 'Bugs',
  feature: 'Feature',
  tests: 'Test suite',
  readability: 'Readability',
  custom: 'Custom',
};

/** The custom variant's default directive — shown in the editor until the
 *  user replaces it, and used as the runtime fallback when no prompt is
 *  saved. Edit freely: it is the placeholder. */
export const CUSTOM_PLACEHOLDER = [
  'AUTONOMOUS MODE: CUSTOM',
  '- Work happens exclusively in the project fork (path announced at kick-off); the original project is never touched.',
  '- Spawn the read-only plan agent inside the fork as research counsel. Dispatch it to research your objective and propose a ranked plan.',
  '- For each meaningful item: renew the goal via set_goal, dispatch build agents to implement, verify with read_tile, search_files and read_test_page before accepting.',
  '- After every round, /compact the read-only agent (type_into_tile /compact) and ask for the next round.',
  '- Iterate until the read-only agent proposes nothing meaningful. Then clear the goal (set_goal empty), write your final verdict and stop.',
  '- You set and clear goals yourself for this run. Spawns default to the remembered launcher; ask_user auto-resolves — decide yourself.',
].join('\n');
