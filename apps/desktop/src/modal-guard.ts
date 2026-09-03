/**
 * One shared "a modal is open" signal. The global shortcut layer must not
 * act (close tiles, move focus, spawn dialogs) while any modal surface is
 * up — the NewTileDialog guard alone covered only one of six modal paths.
 * Mount/unmount symmetry makes depth counting leak-proof.
 */
let depth = 0;

export function modalOpened(): void {
  depth += 1;
}

export function modalClosed(): void {
  depth = Math.max(0, depth - 1);
}

export function modalDepth(): number {
  return depth;
}
