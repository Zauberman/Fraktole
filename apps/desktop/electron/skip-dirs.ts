/** Heavy or recursive directories never walked by the quick-open file
 *  picker. Kept separate from FORK_SKIP_DIRS so neither walker's behavior
 *  changes: quick-open skips its full list, the fork walker skips only its
 *  own six. */
export const PROJECT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'dist-electron',
  'dist-renderer',
  'release',
  '.fraktole-auto',
  '.dart_tool',
  'android',
  '.gradle',
  '.idea',
  'coverage',
]);

/** Directories never carried into a fork — heavy or recursive by nature. */
export const FORK_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.fraktole-auto', 'release']);
