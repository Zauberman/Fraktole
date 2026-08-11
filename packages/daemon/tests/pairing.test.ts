import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PairingStore } from '../src/pairing.js';

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'fraktole-pair-'));
  const store = new PairingStore(join(dir, 'devices.jsonl'));
  await store.load();
  return { store, dir };
}

describe('PairingStore', () => {
  it('exchanges a one-time code for a device token and persists it', async () => {
    const { store, dir } = await makeStore();
    const code = store.createCode();
    const device = store.exchangeCode(code);

    expect(device?.token).toHaveLength(64);
    expect(store.isDeviceToken(device!.token)).toBe(true);
    expect(store.exchangeCode(code)).toBeUndefined(); // one-time only
    await store.flush();

    const reloaded = new PairingStore(join(dir, 'devices.jsonl'));
    await reloaded.load();
    expect(reloaded.isDeviceToken(device!.token)).toBe(true);
  });

  it('rejects unknown, reused and expired codes', async () => {
    const { store } = await makeStore();
    expect(store.exchangeCode('deadbeef')).toBeUndefined();

    const code = store.createCode();
    store.exchangeCode(code);
    expect(store.exchangeCode(code)).toBeUndefined();

    const { store: store2 } = await makeStore();
    const oldCode = store2.createCode();
    (store2 as unknown as { pendingCodes: Map<string, number> }).pendingCodes.set(
      oldCode,
      Date.now() - 1,
    );
    expect(store2.exchangeCode(oldCode)).toBeUndefined();
  });

  it('revokes devices', async () => {
    const { store } = await makeStore();
    const device = store.exchangeCode(store.createCode())!;
    expect(store.revoke(device.id)).toBe(true);
    expect(store.isDeviceToken(device.token)).toBe(false);
    expect(store.revoke(device.id)).toBe(false);
  });
});
