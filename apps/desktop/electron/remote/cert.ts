import {
  createHash,
  createPrivateKey,
  createSign,
  createVerify,
  generateKeyPair,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Promise wrapper around the callback-style RSA keygen. */
function generateRsaKeyPair(): Promise<{ publicKey: KeyObject; privateKey: KeyObject }> {
  return new Promise((resolve, reject) => {
    generateKeyPair('rsa', { modulusLength: 2048, publicExponent: 0x10001 }, (err, publicKey, privateKey) => {
      if (err) reject(err);
      else resolve({ publicKey, privateKey });
    });
  });
}

/** Minimal DER encoder sufficient to build a self-signed X.509 v3 server
 *  certificate (RSA-2048 / SHA-256). We hand-roll the ASN.1 because the
 *  project keeps its dependency surface minimal and node:crypto has no
 *  certificate *issuance* API — only X509Certificate parsing.
 *
 *  The result is a CA-less server cert: the phone pins the SHA-256
 *  fingerprint after the first pairing (TOFU), so no CA chain is needed.
 */

function derLength(bytes: number): Uint8Array {
  if (bytes < 0x80) return Uint8Array.of(bytes);
  if (bytes <= 0xff) return Uint8Array.of(0x81, bytes);
  if (bytes <= 0xffff) return Uint8Array.of(0x82, bytes >> 8, bytes & 0xff);
  return Uint8Array.of(0x83, (bytes >> 16) & 0xff, (bytes >> 8) & 0xff, bytes & 0xff);
}

function derTlv(tag: number, content: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + derLength(content.length).length + content.length);
  out[0] = tag;
  out.set(derLength(content.length), 1);
  out.set(content, 1 + derLength(content.length).length);
  return out;
}

function derSequence(...parts: Uint8Array[]): Uint8Array {
  const content = concat(parts);
  return derTlv(0x30, content);
}

function derSet(...parts: Uint8Array[]): Uint8Array {
  const content = concat(parts);
  return derTlv(0x31, content);
}

function derInteger(value: bigint): Uint8Array {
  let bytes: number[] = [];
  let v = value;
  if (v === 0n) {
    bytes = [0];
  } else {
    while (v > 0n) {
      bytes.unshift(Number(v & 0xffn));
      v >>= 8n;
    }
    // DER requires the high bit of the first byte to be 0 for positive
    // integers (sign bit), so a leading 0x00 byte is added when needed.
    if (bytes[0]! >= 0x80) bytes.unshift(0);
  }
  return derTlv(0x02, Uint8Array.from(bytes));
}

function derBitString(content: Uint8Array): Uint8Array {
  const out = new Uint8Array(content.length + 1);
  out[0] = 0; // unused-bits count
  out.set(content, 1);
  return derTlv(0x03, out);
}

function derOid(oid: string): Uint8Array {
  const parts = oid.split('.').map((n) => Number(n));
  const body: number[] = [];
  const first = parts[0]! * 40 + parts[1]!;
  body.push(first);
  for (const part of parts.slice(2)) {
    let v = part;
    const chunk: number[] = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    body.push(...chunk);
  }
  return derTlv(0x06, Uint8Array.from(body));
}

function derUtf8String(text: string): Uint8Array {
  return derTlv(0x0c, new TextEncoder().encode(text));
}

/** GeneralizedTime (4-digit year). UTCTime only encodes years 1950-2049 —
 *  with a 10-year validity window a cert minted from 2040 on would silently
 *  be read as 19xx and instantly "expired". */
function derGeneralizedTime(d: Date): Uint8Array {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const s = `${pad(d.getUTCFullYear())}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return derTlv(0x18, new TextEncoder().encode(s));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** DER Name = SEQUENCE of SETs, each SET wrapping one AttributeTypeAndValue. */
function derName(cn: string, org: string): Uint8Array {
  const attr = (oid: string, value: Uint8Array): Uint8Array => derSequence(derOid(oid), value);
  const cnAttr = derSet(attr('2.5.4.3', derUtf8String(cn))); // commonName
  const oAttr = derSet(attr('2.5.4.10', derUtf8String(org))); // organizationName
  return derSequence(oAttr, cnAttr);
}

const SHA256_RSA = derSequence(derOid('1.2.840.113549.1.1.11'), derTlv(0x05, new Uint8Array(0)));
const RSA_ENCRYPTION = derSequence(derOid('1.2.840.113549.1.1.1'), derTlv(0x05, new Uint8Array(0)));

/** Generates a fresh self-signed cert for 10 years, returns PEM + fingerprint.
 *  Async so the (comparatively slow) RSA keygen never blocks the main thread. */
async function generateCert(): Promise<{ certPem: string; keyPem: string; fingerprint256: string }> {
  const { publicKey, privateKey } = await generateRsaKeyPair();

  // PKCS#1 RSAPublicKey DER — exactly the structure wrapped by SPKI.
  const rsaPub = publicKey.export({ type: 'pkcs1', format: 'der' });
  const spki = derSequence(RSA_ENCRYPTION, derBitString(rsaPub));

  const serial = randomBytes(16);
  const now = Date.now();
  const notBefore = new Date(now - 24 * 3600_000);
  const notAfter = new Date(now + 10 * 365 * 24 * 3600_000);
  const name = derName('Fraktole Remote', 'Fraktole');

  const tbs = derSequence(
    derTlv(0xa0, derInteger(2n)), // [0] EXPLICIT version v3
    derInteger(BigInt('0x' + serial.toString('hex'))),
    SHA256_RSA,
    name, // issuer
    derSequence(derGeneralizedTime(notBefore), derGeneralizedTime(notAfter)),
    name, // subject
    spki, // subjectPublicKeyInfo
  );

  const signer = createSign('RSA-SHA256');
  signer.update(tbs);
  signer.end();
  const signature = signer.sign(privateKey);

  const cert = derSequence(tbs, SHA256_RSA, derBitString(signature));

  const fingerprint256 = createHash('sha256').update(cert).digest('hex');

  const toPem = (label: string, der: Uint8Array): string => {
    const b64 = Buffer.from(der).toString('base64');
    const lines = b64.match(/.{1,64}/g) ?? [];
    return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
  };

  return {
    certPem: toPem('CERTIFICATE', cert),
    keyPem: String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    fingerprint256,
  };
}

export interface RemoteCert {
  certPem: string;
  keyPem: string;
  /** Lowercase hex SHA-256 of the DER certificate (the pairing pin). */
  fingerprint256: string;
}

/** Loads the persisted cert/key pair, generating them when absent. A persisted
 *  pair whose key is unreadable or does not match the cert is regenerated too
 *  (a torn first write, a crash between the key and cert writes, or manual
 *  tampering must never leave the bridge permanently broken). */
export async function loadOrCreateCert(dir: string): Promise<RemoteCert> {
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  try {
    const [certPem, keyPem] = await Promise.all([readFile(certFile, 'utf8'), readFile(keyFile, 'utf8')]);
    const cert = new (await import('node:crypto')).X509Certificate(certPem);
    // verify the persisted key actually belongs to the persisted cert (a
    // corrupt or mismatched key must be regenerated, not shipped to TLS):
    // sign a probe with the key and check it against the cert's public key
    const probe = 'frakt-tofu-key-check';
    const verifier = createVerify('RSA-SHA256');
    verifier.update(probe);
    if (!verifier.verify(cert.publicKey, createSign('RSA-SHA256').update(probe).sign(createPrivateKey(keyPem)))) {
      throw new Error('persisted key does not match the certificate');
    }
    return { certPem, keyPem, fingerprint256: cert.fingerprint256.replaceAll(':', '').toLowerCase() };
  } catch {
    // missing, unreadable, or an inconsistent pair — generate a fresh one
  }
  const generated = await generateCert();
  await mkdir(dir, { recursive: true });
  // atomic (tmp + rename) and key-first: a crash mid-write leaves either the
  // old pair or a mismatched one that the consistency check above regenerates
  await writeFile(`${keyFile}.tmp`, generated.keyPem, { encoding: 'utf8', mode: 0o600 });
  await rename(`${keyFile}.tmp`, keyFile);
  // chmod explicitly — a previous generation may have raced or the umask
  // widened it before writeFile's mode applied
  await chmod(keyFile, 0o600);
  await writeFile(`${certFile}.tmp`, generated.certPem, { encoding: 'utf8', mode: 0o600 });
  await rename(`${certFile}.tmp`, certFile);
  return generated;
}

/** Human-readable fingerprint: colon-separated uppercase hex pairs. */
export function formatFingerprint(hex: string): string {
  const clean = hex.toLowerCase().replaceAll(':', '');
  const pairs = clean.match(/.{1,2}/g) ?? [];
  return pairs.map((p) => p.toUpperCase()).join(':');
}

/** Pairs of hex digits → fingerprint without separators (for cross-checking). */
export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.toLowerCase().replaceAll(':', '');
}
