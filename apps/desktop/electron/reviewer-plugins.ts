/** Autonomous-mode prompt plugins ("Auto compose"). Each variant appends an
 *  AUTONOMOUS MODE section to the system prompt: a mission, the research-
 *  propose-fix-compact loop, and the self-goaling authority for the run.
 */

export type AutonomyVariant = 'cyber' | 'frontend' | 'bugs';

export const AUTONOMY_VARIANTS: readonly AutonomyVariant[] = ['cyber', 'frontend', 'bugs'];

export const AUTONOMY_NAMES: Record<AutonomyVariant, string> = {
  cyber: 'Cyber',
  frontend: 'Frontend',
  bugs: 'Bugs',
};

/** The goal armed automatically when a variant is picked. */
export const AUTONOMY_MISSIONS: Record<AutonomyVariant, string> = {
  cyber: 'Autonomous cybersecurity audit: find and fix vulnerabilities in the project fork.',
  frontend: 'Autonomous frontend rework: find and implement meaningful visual, UX and performance improvements in the project fork.',
  bugs: 'Autonomous bug hunt: find and fix real bugs in the project fork.',
};

export const AUTONOMY_PLUGINS: Record<AutonomyVariant, string> = {
  cyber: [
    'AUTONOMOUS MODE: CYBER',
    '- Work happens exclusively in the project fork (path announced at kick-off); the original project is never touched.',
    '- Spawn the read-only plan agent inside the fork as research counsel. Dispatch it to hunt cybersecurity issues: injection, auth flaws, secret leakage, unsafe dependencies, insecure defaults — findings ranked by impact with fix plans.',
    '- For each meaningful finding: renew the goal via set_goal, dispatch build agents to implement, verify with read_tile and search_files before accepting.',
    '- After every fix round, /compact the read-only agent (type_into_tile /compact) and ask for the next round of findings.',
    '- Iterate until the read-only agent proposes nothing meaningful. Then clear the goal (set_goal empty), write your final verdict and stop.',
    '- You set and clear goals yourself for this run. Spawns default to the remembered launcher; ask_user auto-resolves — decide yourself.',
  ].join('\n'),
  frontend: [
    'AUTONOMOUS MODE: FRONTEND',
    '- Work happens exclusively in the project fork (path announced at kick-off); the original project is never touched.',
    '- Spawn the read-only plan agent inside the fork as research counsel. Dispatch it to find meaningful frontend reworks and improvements: visual polish, layout and responsiveness, accessibility, performance, UX flows — ranked by impact with fix plans. Be strict: great frontend, not passable frontend.Also keep the typographic vibrant approach when prompting the read only agent : no live entity icons anywhere.',
    '- For each meaningful proposal: renew the goal via set_goal, dispatch build agents to implement, verify with read_tile and read_test_page (console errors, loading) before accepting.',
    '- After every fix round, /compact the read-only agent (type_into_tile /compact) and ask for the next round of proposals.',
    '- Iterate until the read-only agent proposes nothing meaningful. Then clear the goal (set_goal empty), write your final verdict and stop.',
    '- You set and clear goals yourself for this run. Spawns default to the remembered launcher; ask_user auto-resolves — decide yourself.',
  ].join('\n'),
  bugs: [
    'AUTONOMOUS MODE: BUGS',
    '- Work happens exclusively in the project fork (path announced at kick-off); the original project is never touched.',
    '- Spawn the read-only plan agent inside the fork as research counsel. Dispatch it to find real bugs: crashes, wrong behavior, edge cases, race conditions, error paths — ranked by severity with reproductions and fixes.',
    '- For each meaningful finding: renew the goal via set_goal, dispatch build agents to implement, verify with read_tile and read_test_page before accepting.',
    '- After every fix round, /compact the read-only agent (type_into_tile /compact) and ask for the next round of findings.',
    '- Iterate until the read-only agent proposes nothing meaningful. Then clear the goal (set_goal empty), write your final verdict and stop.',
    '- You set and clear goals yourself for this run. Spawns default to the remembered launcher; ask_user auto-resolves — decide yourself.',
  ].join('\n'),
};
