import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODELS,
  REVIEWER_MODEL_SUGGESTIONS,
  resolveProvider,
} from '../src/shared/reviewer-detect.js';

describe('resolveProvider — no key', () => {
  it('resolves to keyless ollama with a local endpoint', () => {
    const r = resolveProvider('');
    expect(r.adapter).toBe('ollama');
    expect(r.baseUrl).toBe('http://localhost:11434');
    expect(r.model).toBe(DEFAULT_MODELS.ollama);
    expect(r.ambiguous).toBe(false);
  });

  it('trims whitespace around the key', () => {
    expect(resolveProvider('   ').adapter).toBe('ollama');
    expect(resolveProvider('  sk-ant-x  ').adapter).toBe('anthropic');
  });
});

describe('resolveProvider — unambiguous prefixes', () => {
  it('sk-ant- resolves to anthropic', () => {
    const r = resolveProvider('sk-ant-api03-abc123');
    expect(r.adapter).toBe('anthropic');
    expect(r.baseUrl).toBe('https://api.anthropic.com');
    expect(r.model).toBe(DEFAULT_MODELS.anthropic);
    expect(r.ambiguous).toBe(false);
  });

  it('sk-proj- and sk-svcacct- resolve to openai', () => {
    for (const key of ['sk-proj-abc123', 'sk-svcacct-abc123']) {
      const r = resolveProvider(key);
      expect(r.adapter).toBe('openai');
      expect(r.baseUrl).toBe('https://api.openai.com/v1');
      expect(r.ambiguous).toBe(false);
    }
  });

  it('an unambiguous prefix wins over a stale provider hint', () => {
    const r = resolveProvider('sk-ant-api03-x', { providerHint: 'openai' });
    expect(r.adapter).toBe('anthropic');
  });
});

describe('resolveProvider — ambiguous sk- keys', () => {
  it('a bare sk- key is ambiguous and defaults to openai', () => {
    const r = resolveProvider('sk-123abc');
    expect(r.adapter).toBe('openai');
    expect(r.baseUrl).toBe('https://api.openai.com/v1');
    expect(r.ambiguous).toBe(true);
  });

  it('a deepseek baseUrl hint routes to the deepseek endpoint', () => {
    const r = resolveProvider('sk-123abc', { baseUrl: 'https://api.deepseek.com/v1' });
    expect(r.adapter).toBe('openai');
    expect(r.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(r.model).toBe(DEFAULT_MODELS.deepseek);
    expect(r.ambiguous).toBe(false);
  });

  it('a deepseek provider hint works without a baseUrl', () => {
    const r = resolveProvider('sk-123abc', { providerHint: 'deepseek' });
    expect(r.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(r.model).toBe(DEFAULT_MODELS.deepseek);
    expect(r.ambiguous).toBe(false);
  });

  it('an explicit openai pick resolves the ambiguity', () => {
    const r = resolveProvider('sk-123abc', { providerHint: 'openai' });
    expect(r.adapter).toBe('openai');
    expect(r.ambiguous).toBe(false);
  });

  it('a custom baseUrl resolves any key against that endpoint', () => {
    const r = resolveProvider('sk-123abc', { baseUrl: 'http://127.0.0.1:9876/v1' });
    expect(r.adapter).toBe('openai');
    expect(r.baseUrl).toBe('http://127.0.0.1:9876/v1');
    expect(r.ambiguous).toBe(false);
  });

  it('unknown-prefix keys are ambiguous without a baseUrl', () => {
    const r = resolveProvider('my-vendor-key-xyz');
    expect(r.adapter).toBe('openai');
    expect(r.ambiguous).toBe(true);
    const withBase = resolveProvider('my-vendor-key-xyz', { baseUrl: 'http://127.0.0.1:9999/v1' });
    expect(withBase.ambiguous).toBe(false);
  });
});

describe('model hints and suggestions', () => {
  it('modelHint overrides the per-provider default', () => {
    const r = resolveProvider('sk-ant-x', { modelHint: 'claude-opus-4-1' });
    expect(r.model).toBe('claude-opus-4-1');
  });

  it('every provider has suggestions and a default', () => {
    for (const provider of ['anthropic', 'openai', 'deepseek', 'ollama'] as const) {
      expect(REVIEWER_MODEL_SUGGESTIONS[provider].length).toBeGreaterThan(0);
      expect(DEFAULT_MODELS[provider].length).toBeGreaterThan(0);
    }
  });
});
