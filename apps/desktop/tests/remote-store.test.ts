import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashToken, RemoteStore } from '../electron/remote/store.js';

describe('RemoteStore', () => {
  it('defaults to disabled on a fresh directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frakt-store-'));
    const store = new RemoteStore(dir);
    const state = await store.get();
    expect(state.enabled).toBe(false);
    expect(state.port).toBe(8833);
    expect(state.devices).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('persists enabled-state and port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frakt-store-'));
    const store = new RemoteStore(dir);
    await store.setEnabled(true);
    await store.setPort(9000);
    // a fresh instance reads the same state back from disk
    const again = new RemoteStore(dir);
    const state = await again.get();
    expect(state.enabled).toBe(true);
    expect(state.port).toBe(9000);
    await rm(dir, { recursive: true, force: true });
  });

  it('clamps invalid ports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frakt-store-'));
    const store = new RemoteStore(dir);
    await store.setPort(0);
    await store.setPort(99999);
    expect((await store.get()).port).toBe(8833);
    await rm(dir, { recursive: true, force: true });
  });

  it('stores only the SHA-256 hash of the token, never the plaintext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frakt-store-'));
    const store = new RemoteStore(dir);
    const { device, token } = await store.addDevice('Pixel 8');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(device.tokenHash).toBe(hashToken(token));
    expect(device.tokenHash).not.toBe(token);

    const raw = await readFile(join(dir, 'state.json'), 'utf8');
    expect(raw).not.toContain(token); // no plaintext anywhere on disk
    expect(raw).toContain(device.tokenHash);

    // tokens are unforgeable: different token ⇒ different hash
    const other = randomBytes(32).toString('hex');
    expect(hashToken(other)).not.toBe(device.tokenHash);
    expect(createHash('sha256').update(token).digest('hex')).toBe(device.tokenHash);
    await rm(dir, { recursive: true, force: true });
  });

  it('revokeDevice removes the entry and reports whether it existed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frakt-store-'));
    const store = new RemoteStore(dir);
    const { device } = await store.addDevice('Pixel 8');
    expect(await store.revokeDevice('nope')).toBe(false);
    expect(await store.revokeDevice(device.deviceId)).toBe(true);
    const state = await store.get();
    expect(state.devices).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('touchDevice updates lastSeen only for known devices', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frakt-store-'));
    const store = new RemoteStore(dir);
    const { device } = await store.addDevice('Pixel 8');
    const before = device.lastSeen;
    await store.touchDevice(device.deviceId, before + 5000);
    expect((await store.get()).devices[0]!.lastSeen).toBe(before + 5000);
    await store.touchDevice('ghost', 42);
    expect((await store.get()).devices[0]!.lastSeen).toBe(before + 5000);
    await rm(dir, { recursive: true, force: true });
  });

  it('sanitizes device names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frakt-store-'));
    const store = new RemoteStore(dir);
    const evil = `Bad\u0000Device\u0007${'x'.repeat(200)}`;
    const { device } = await store.addDevice(evil);
    expect(device.name.startsWith('BadDevice')).toBe(true);
    expect(device.name.length).toBeLessThanOrEqual(64);
    // eslint-disable-next-line no-control-regex
    expect(device.name).not.toMatch(/[\u0000-\u001f]/);
    await rm(dir, { recursive: true, force: true });
  });
});
