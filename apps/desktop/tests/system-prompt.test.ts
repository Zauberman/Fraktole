import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../electron/reviewer.js';

const prompt = buildSystemPrompt('s-test', '/tmp/proj');

describe('system prompt', () => {
  it('has the three structural sections', () => {
    expect(prompt).toContain('OPERATING PROTOCOL');
    expect(prompt).toContain('VERIFYING & JUDGING RESULTS');
    expect(prompt).toContain('REPORTING');
  });

  it('demands verification over trust', () => {
    expect(prompt).toContain('Never take an agent\'s word for a result');
    expect(prompt).toContain('read_test_page (console errors, loading)');
    expect(prompt).toContain('search_files (stubs, TODOs, wrong symbols)');
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
    expect(prompt).toContain('Never set, change or clear the goal yourself');
    expect(prompt).toContain('ASCII only');
  });

  it('contains no emoji or decorative unicode', () => {
    expect(prompt).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('stays lean (<= 450 words) to bound per-turn cost', () => {
    const words = prompt.split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(450);
  });
});
