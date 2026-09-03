import React from 'react';
import { bridge } from '../ipc.js';
import { sanitizeChatText } from '../shared/sanitize.js';

/** The tool-card slice of a transcript item. Kept structural so the card
 *  does not depend on ReviewerTab's local item type. */
export interface ReviewerToolItem {
  callId?: string;
  seq: number;
  name?: string;
  args?: string;
  state?: 'start' | 'done' | 'error';
  detail?: string;
  durationMs?: number;
}

/** Pure presentational card for one reviewer tool call: name, state,
 *  duration, args, a copy-result button, and the collapsible detail block.
 *  Extracted from ReviewerTab so the transcript renderer stays readable.
 *  Memoized: a streaming transcript re-renders only cards whose item
 *  identity or expansion actually changed. */
export const ReviewerToolCard = React.memo(function ReviewerToolCard(props: {
  it: ReviewerToolItem;
  expanded: boolean;
  /** Toggles the card by its transcript key (callId or seq). */
  onToggle(callKey: string): void;
}): React.JSX.Element {
  const { it, expanded: open, onToggle } = props;
  const callKey = it.callId ?? String(it.seq);
  // the transcript state is start|done|error; the CSS contract is
  // running|done|error — map instead of emitting an unstyled -start class
  const phase = it.state === 'start' || it.state === undefined ? 'running' : it.state;
  return (
<div key={it.seq} className={`reviewer-item reviewer-item-tool reviewer-item-tool-${phase}`}>
  <span className={`reviewer-tool-band reviewer-tool-band-${phase}`} aria-hidden="true" />
  <div className="reviewer-tool-header">
    <div className="reviewer-tool-row">
      <button type="button" className="reviewer-tool-toggle" onClick={() => onToggle(callKey)}>
        <svg
          className={`reviewer-tool-chevron${open ? ' reviewer-tool-chevron-open' : ''}`}
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <path d="M3 1 L8 5 L3 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
        </svg>
        <span className="reviewer-tool-name">{it.name}</span>
      </button>
      <span className={`reviewer-tool-state reviewer-tool-state-${phase}`}>
        {it.state === 'start' || it.state === undefined ? 'running' : it.state}
      </span>
      {it.state !== 'start' && it.durationMs !== undefined && (
        <span className="reviewer-item-time">{it.durationMs}ms</span>
      )}
      {it.state !== 'start' && it.detail !== undefined && (
        <button
          type="button"
          className="reviewer-icon-btn"
          title="copy result"
          onClick={() => void bridge.clipboardWrite(it.detail ?? '')}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
            <rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="M7.5 3.5 V2.5 C7.5 1.95 7.05 1.5 6.5 1.5 H2.5 C1.95 1.5 1.5 1.95 1.5 2.5 V6.5 C1.5 7.05 1.95 7.5 2.5 7.5 H3.5"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="square"
            />
          </svg>
        </button>
      )}
    </div>
    {it.args !== undefined && (
      <span className="reviewer-tool-args">{sanitizeChatText(it.args)}</span>
    )}
  </div>
  {open && it.detail !== undefined && (
    <pre className="reviewer-tool-detail">{sanitizeChatText(it.detail)}</pre>
  )}
</div>
  );
});
