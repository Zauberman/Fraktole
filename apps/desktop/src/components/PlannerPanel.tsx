import React from 'react';

/**
 * Placeholder for the planner-agent logic, which ships in a later release.
 * Deliberately non-interactive.
 */
export function PlannerPanel(): React.JSX.Element {
  return (
    <div className="planner">
      <header className="pane-header">
        <div className="pane-title">Planner Agent</div>
      </header>
      <div className="planner-empty">
        <div className="planner-empty-mark">PLANNER<span className="boot-dot">.</span></div>
        <div className="planner-empty-hint">decomposition and orchestration ship in a later release</div>
      </div>
    </div>
  );
}
