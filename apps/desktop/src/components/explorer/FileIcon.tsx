import type { FsEntry } from '../../ipc.js';

type IconKind = 'dir' | 'ts' | 'js' | 'json' | 'md' | 'css' | 'html' | 'py' | 'sh' | 'file';

function iconKind(entry: FsEntry): IconKind {
  if (entry.isDir) return 'dir';
  const name = entry.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'ts';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'js';
    case 'json':
      return 'json';
    case 'md':
    case 'mdx':
      return 'md';
    case 'css':
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    case 'py':
      return 'py';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'sh';
    default:
      return 'file';
  }
}

/** Per-type inner glyphs drawn inside the page outline (12x12 grid). */
function glyph(kind: IconKind): React.JSX.Element | null {
  const s = { stroke: 'currentColor', strokeWidth: 1.5, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'ts':
      return (
        <g {...s}>
          <path d="M5 4.8 L3.6 6.2 L5 7.6" />
          <path d="M7 4.8 L8.4 6.2 L7 7.6" />
        </g>
      );
    case 'js':
      return (
        <g {...s}>
          <path d="M5.4 4.6 C4.4 4.6 4.4 6.2 3.6 6.2 C4.4 6.2 4.4 7.8 5.4 7.8" />
          <path d="M6.6 4.6 C7.6 4.6 7.6 6.2 8.4 6.2 C7.6 6.2 7.6 7.8 6.6 7.8" />
        </g>
      );
    case 'json':
      return (
        <g {...s}>
          <path d="M5 4.6 C4.2 4.6 4.2 5.9 3.4 6 C4.2 6.1 4.2 7.4 5 7.4" />
          <path d="M7 4.6 C7.8 4.6 7.8 5.9 8.6 6 C7.8 6.1 7.8 7.4 7 7.4" />
          <path d="M6 6 L6.01 6" />
        </g>
      );
    case 'md':
      return (
        <g {...s}>
          <path d="M3.5 4.8 H8.5" />
          <path d="M3.5 7.2 H6.5" />
        </g>
      );
    case 'css':
      return (
        <g {...s}>
          <path d="M4.6 4.2 V7.8" />
          <path d="M7.4 4.2 V7.8" />
          <path d="M3.4 5.2 H8.6" />
          <path d="M3.4 6.8 H8.6" />
        </g>
      );
    case 'html':
      return (
        <g {...s}>
          <path d="M4.6 4.8 L3.4 6 L4.6 7.2" />
          <path d="M7.4 4.8 L8.6 6 L7.4 7.2" />
          <path d="M6.5 4.4 L5.5 7.6" />
        </g>
      );
    case 'py':
      return (
        <g {...s}>
          <path d="M6 3.8 V5.2" />
          <path d="M6 6.8 V8.2" />
          <path d="M3.8 6 H5.2" />
          <path d="M6.8 6 H8.2" />
          <path d="M6 6 L6.01 6" />
        </g>
      );
    case 'sh':
      return (
        <g {...s}>
          <path d="M3.6 4.8 L5.2 6.2 L3.6 7.6" />
          <path d="M6.4 7.6 H8.6" />
        </g>
      );
    default:
      return null;
  }
}

/** Bespoke 12px file-type glyph (folder, code types, fallback page) drawn
 *  inline with currentColor so the tree row drives the tint. */
export function FileIcon({ entry }: { entry: FsEntry }): React.JSX.Element {
  const kind = iconKind(entry);
  if (kind === 'dir') {
    return (
      <svg className="explorer-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path
          d="M1.5 3 C1.5 2.45 1.95 2 2.5 2 H4.6 L5.8 3.4 H9.5 C10.05 3.4 10.5 3.85 10.5 4.4 V9 C10.5 9.55 10.05 10 9.5 10 H2.5 C1.95 10 1.5 9.55 1.5 9 Z"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg className="explorer-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 1.5 H6.8 L9.5 4.2 V10.5 H2.5 Z"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinejoin="round"
      />
      <path d="M6.8 1.5 V4.2 H9.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
      {glyph(kind)}
    </svg>
  );
}
