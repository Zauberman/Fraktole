import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { formatFingerprint, loadOrCreateCert, normalizeFingerprint } from '../electron/remote/cert.js';

describe('loadOrCreateCert', () => {
  it('generates a parseable self-signed cert and its key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frakt-cert-'));
    const cert = await loadOrCreateCert(dir);

    expect(cert.fingerprint256).toMatch(/^[0-9a-f]{64}$/);
    const parsed = new X509Certificate(cert.certPem);
    expect(parsed.subject).toContain('Fraktole Remote');
    expect(parsed.issuer).toBe(parsed.subject); // self-signed
    expect(parsed.validToDate.getTime()).toBeGreaterThan(Date.now());
    expect(parsed.fingerprint256.replaceAll(':', '').toLowerCase()).toBe(cert.fingerprint256);

    const keyStat = await stat(join(dir, 'key.pem'));
    expect(keyStat.mode & 0o777).toBe(0o600);
    const keyPem = await readFile(join(dir, 'key.pem'), 'utf8');
    expect(keyPem).toContain('BEGIN PRIVATE KEY');
    await rm(dir, { recursive: true, force: true });
  });

  it('is idempotent: reuses the persisted pair and the same fingerprint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frakt-cert-'));
    const first = await loadOrCreateCert(dir);
    const second = await loadOrCreateCert(dir);
    expect(second.certPem).toBe(first.certPem);
    expect(second.keyPem).toBe(first.keyPem);
    expect(second.fingerprint256).toBe(first.fingerprint256);
    await rm(dir, { recursive: true, force: true });
  });

  it('fingerprint matches a sha256 over the DER bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frakt-cert-'));
    const cert = await loadOrCreateCert(dir);
    const parsed = new X509Certificate(cert.certPem);
    const der = Buffer.from(parsed.raw);
    expect(createHash('sha256').update(der).digest('hex')).toBe(cert.fingerprint256);
    await rm(dir, { recursive: true, force: true });
  });

  it('a transient read error (EISDIR) propagates and does not regenerate or write anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frakt-cert-'));
    // Create cert.pem as a DIRECTORY so readFile throws EISDIR (a
    // deterministic non-ENOENT error that simulates a transient I/O blip)
    await mkdir(join(dir, 'cert.pem'), { recursive: true });

    await expect(loadOrCreateCert(dir)).rejects.toThrow();
    // Ensure nothing was written (no key.pem, no cert.pem file)
    const keyExists = await stat(join(dir, 'key.pem')).then(() => true).catch(() => false);
    const certIsFile = await stat(join(dir, 'cert.pem')).then((s) => s.isFile()).catch(() => false);
    expect(keyExists).toBe(false);
    expect(certIsFile).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('formatFingerprint / normalizeFingerprint', () => {
  it('formats hex as colon-separated uppercase pairs', () => {
    expect(formatFingerprint('aabb')).toBe('AA:BB');
    expect(formatFingerprint('0011223344')).toBe('00:11:22:33:44');
  });

  it('normalizes any fingerprint to bare lowercase hex', () => {
    expect(normalizeFingerprint('AA:BB:CC')).toBe('aabbcc');
    expect(normalizeFingerprint('aabbcc')).toBe('aabbcc');
  });
});
