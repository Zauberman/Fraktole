import React from 'react';
import { Dialog } from './Dialog.js';

export interface HelpCommand {
  cmd: string;
  desc: string;
}

export interface HelpSection {
  label: string;
  items: HelpCommand[];
}

/** Help → Reviewer commands — the command codex: commands grouped into
 *  tinted sections on a chip grid, not a wall of preformatted text. */
export function HelpDialog(props: { sections: HelpSection[]; onClose: () => void }): React.JSX.Element {
  return (
    <Dialog title="reviewer commands" onClose={props.onClose} accent="palette" size="lg" footer={
      <button type="button" className="btn btn-sm btn-primary" onClick={props.onClose}>
        close
      </button>
    }>
      <div className="codex">
        {props.sections.map((section) => (
          <section key={section.label} className={`codex-section codex-${section.label}`}>
            <div className="codex-label">{section.label}</div>
            <div className="codex-items">
              {section.items.map((item) => (
                <div key={item.cmd} className="codex-item">
                  <code className="codex-cmd">{item.cmd}</code>
                  <span className="codex-desc">{item.desc}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
