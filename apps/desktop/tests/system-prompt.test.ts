import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../electron/reviewer.js';
import { AUTONOMY_PLUGINS, AUTONOMY_MISSIONS, AUTONOMY_VARIANTS } from '../electron/reviewer-plugins.js';

const prompt = buildSystemPrompt('s-test', '/tmp/proj');

describe('system prompt', () => {
  it('has the three structural sections', () => {
    expect(prompt).toContain('OPERATING PROTOCOL');
    expect(prompt).toContain('VERIFYING & JUDGING RESULTS');
    expect(prompt).toContain('REPORTING');
  });

  it('demands verification over trust', () => {
    expect(prompt).toContain('Verify important results');
    expect(prompt).toContain('read_test_page (console errors, loading)');
    expect(prompt).toContain('search_files (stubs, TODOs, wrong symbols)');
  });

  it('delegates substantive work by default but keeps the hands-on option', () => {
    expect(prompt).toContain('GENERAL');
    expect(prompt).toContain('DELEGATE substantive work');
    expect(prompt).toContain('2 build agents for implementation');
    expect(prompt).toContain('1 plan (read only) agent');
    expect(prompt).toContain('small fixes go to the fixes agent');
    expect(prompt).toContain('break it into sub-goals with set_goal');
    expect(prompt).toContain('every sub-goal done');
    // the old anti-delegation line is gone
    expect(prompt).not.toContain('Never send a message to an agent unless the task warrants it');
  });

  it('the reviewer is read-only — no shell tools in the prompt', () => {
    expect(prompt).toContain('read-only on the project');
    expect(prompt).not.toContain('run_bash');
    expect(prompt).not.toContain('run_background');
  });

  it('judges results and sub-results against the goal', () => {
    expect(prompt).toContain('Judge every important result');
    expect(prompt).toContain('sub-results');
    expect(prompt).toContain('re-dispatch with a specific, actionable correction');
  });

  it('keeps the balanced-scrutiny guardrail', () => {
    expect(prompt).toContain('Do not micro-check trivia');
  });

  it('keeps the loop-master and GOAL-MET contract', () => {
    expect(prompt).toContain('[goal: ...]');
    expect(prompt).toContain('GOAL-MET:');
  });

  it('keeps the safety and reporting rules', () => {
    expect(prompt).toContain('ask_user');
    expect(prompt).toContain('ASCII only');
  });

  it('contains no emoji or decorative unicode', () => {
    expect(prompt).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('stays lean (<= 520 words) to bound per-turn cost', () => {
    const words = prompt.split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(520);
  });
});

describe('autonomous-mode plugins', () => {
  it('appends the AUTONOMOUS MODE section for every variant', () => {
    for (const v of AUTONOMY_VARIANTS) {
      const full = buildSystemPrompt('s-test', '/tmp/proj', v);
      expect(full).toContain('AUTONOMOUS MODE');
      expect(full).toContain(AUTONOMY_PLUGINS[v]);
    }
  });

  it('the base prompt is untouched without a variant', () => {
    expect(buildSystemPrompt('s-test', '/tmp/proj')).toBe(buildSystemPrompt('s-test', '/tmp/proj', null));
  });

  it('each plugin carries the loop mechanics and stays lean (<= 190 words)', () => {
    for (const v of AUTONOMY_VARIANTS) {
      const p = AUTONOMY_PLUGINS[v];
      expect(p).toContain('set_goal');
      expect(p).toContain('/compact');
      expect(p).toContain('nothing meaningful');
      expect(p).toContain('never touched');
      expect(p).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
      const words = p.split(/\s+/).filter(Boolean).length;
      expect(words, `${v} plugin word count`).toBeLessThanOrEqual(190);
    }
  });

  it('every variant has a mission goal', () => {
    for (const v of AUTONOMY_VARIANTS) {
      expect(AUTONOMY_MISSIONS[v].length).toBeGreaterThan(10);
    }
  });
});
