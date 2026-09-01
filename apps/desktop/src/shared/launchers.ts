/** Launcher allowlist primitives shared by the reviewer harness gatekeeping.
 *  A "launcher" is the command typed into an agent tile to boot a harness
 *  (opencode, agy, claude, …). Gatekeeping rule: the reviewer may spawn or
 *  type ONLY allowlisted launchers into shell tiles — never arbitrary shell
 *  commands. Harness tiles accept any terminal input (their own harness owns
 *  permissioning); these guards protect BARE SHELL tiles exclusively. */

/** Launchers every install knows about. The user's editable setting extends
 *  this list; it can never shrink below it ('shell' included on purpose). */
export const DEFAULT_LAUNCHERS = ['opencode', 'agy', 'claude', 'codex', 'gemini', 'aider', 'shell'] as const;

/** First whitespace-separated token of a command ('' when blank). */
export function launcherFirstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? '';
}

/** Shell metacharacters that make a command more than "run this program":
 *  sequencing/piping/redirection/subshells/expansion/quoting/globs. */
// eslint-disable-next-line no-control-regex
const UNSAFE_COMMAND_RE = /[;|&$`><()'"\\*?[\]{}!\x00-\x1f\x7f]/;
const COMMAND_CAP = 256;

/** True when the command is a single plain program invocation: no shell
 *  metacharacters anywhere, no control bytes, non-empty, bounded length. */
export function commandIsPlainLaunch(command: string): boolean {
  const c = command.trim();
  if (c.length === 0 || c.length > COMMAND_CAP) return false;
  return !UNSAFE_COMMAND_RE.test(c);
}

const LAUNCHER_ENTRY_CAP = 64;
const LAUNCHER_LIST_CAP = 32;

/** Parse the settings value into a clean launcher list: accepts a string[]
 *  or one comma/space separated string; trims, drops empties, dedupes,
 *  bounds each entry and the list. Empty/invalid → undefined (unset). */
export function sanitizeAllowedLaunchers(raw: unknown): string[] | undefined {
  let items: string[];
  if (typeof raw === 'string') items = raw.split(/[,\s]+/);
  else if (Array.isArray(raw)) items = raw.filter((x): x is string => typeof x === 'string');
  else return undefined;
  const out: string[] = [];
  for (const item of items) {
    const t = item.trim().slice(0, LAUNCHER_ENTRY_CAP);
    if (t.length > 0 && !out.includes(t)) out.push(t);
    if (out.length >= LAUNCHER_LIST_CAP) break;
  }
  return out.length > 0 ? out : undefined;
}

/** The launchers the reviewer may actually start: the user's editable list
 *  extended with the defaults and the configured agent launcher's first
 *  whitespace-separated token. Always includes 'shell' via the defaults. */
export function effectiveAllowlist(allowed: string[] | undefined, agentCommand?: string): string[] {
  const out: string[] = [...DEFAULT_LAUNCHERS];
  for (const entry of allowed ?? []) {
    if (!out.includes(entry)) out.push(entry);
  }
  const cmd = agentCommand !== undefined && agentCommand.trim().length > 0 ? launcherFirstToken(agentCommand) : '';
  if (cmd.length > 0 && !out.includes(cmd)) out.push(cmd);
  return out;
}
