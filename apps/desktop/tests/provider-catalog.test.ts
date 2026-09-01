import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CATALOG,
  PROVIDER_GROUPS,
  LOCAL_PROVIDER_IDS,
  CUSTOM_PROVIDER_ID,
  getProvider,
  requiresKey,
} from '../src/shared/provider-catalog.js';

describe('provider catalog — integrity', () => {
  it('is broad (100+ entries)', () => {
    expect(PROVIDER_CATALOG.length).toBeGreaterThanOrEqual(100);
  });

  it('has unique ids', () => {
    const ids = PROVIDER_CATALOG.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has a name, adapter, default model and a valid group', () => {
    for (const p of PROVIDER_CATALOG) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(['openai', 'anthropic', 'ollama']).toContain(p.adapter);
      expect(['cloud', 'local', 'custom']).toContain(p.group);
      if (p.id !== CUSTOM_PROVIDER_ID) expect(p.defaultModel.length).toBeGreaterThan(0);
      expect(['key', 'none', 'optional']).toContain(p.auth);
    }
  });

  it('every non-custom entry has a parseable (and local when local) baseUrl', () => {
    for (const p of PROVIDER_CATALOG) {
      if (p.id === CUSTOM_PROVIDER_ID) continue;
      expect(p.baseUrl.length).toBeGreaterThan(0);
      expect(() => new URL(p.baseUrl)).not.toThrow();
      if (p.group === 'local') {
        expect(p.baseUrl.startsWith('http://localhost')).toBe(true);
      }
    }
  });

  it('local entries are never key-required (keyless or optional)', () => {
    for (const id of LOCAL_PROVIDER_IDS) {
      const p = getProvider(id)!;
      expect(p.auth).not.toBe('key');
      expect(requiresKey(p)).toBe(false);
    }
  });

  it('cloud entries require a key', () => {
    for (const p of PROVIDER_CATALOG) {
      if (p.group !== 'cloud') continue;
      expect(p.auth).toBe('key');
    }
  });

  it('the custom entry is openai-compatible and needs no fixed baseUrl', () => {
    const p = getProvider(CUSTOM_PROVIDER_ID)!;
    expect(p.baseUrl).toBe('');
    expect(p.adapter).toBe('openai');
  });

  it('groups partition the catalog exactly', () => {
    const grouped = PROVIDER_GROUPS.flatMap((g) => g.entries.length);
    expect(grouped.reduce((a, b) => a + b, 0)).toBe(PROVIDER_CATALOG.length);
  });

  it('has a cloud group with many providers', () => {
    const cloud = PROVIDER_GROUPS.find((g) => g.group === 'cloud')!;
    expect(cloud.entries.length).toBeGreaterThanOrEqual(50);
  });
});
