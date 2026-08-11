import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface Device {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

export const CODE_TTL_MS = 10 * 60 * 1000;

export class PairingStore {
  private devices: Device[] = [];
  private readonly pendingCodes = new Map<string, number>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8');
      this.devices = raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Device);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  createCode(): string {
    const code = randomBytes(6).toString('hex');
    this.pendingCodes.set(code, Date.now() + CODE_TTL_MS);
    return code;
  }

  exchangeCode(code: string): Device | undefined {
    const expiresAt = this.pendingCodes.get(code);
    if (expiresAt === undefined || expiresAt < Date.now()) return undefined;
    this.pendingCodes.delete(code);
    const device: Device = {
      id: randomUUID(),
      name: 'phone',
      token: randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    this.devices.push(device);
    void this.save();
    return device;
  }

  list(): Device[] {
    return [...this.devices];
  }

  revoke(deviceId: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== deviceId);
    const removed = this.devices.length < before;
    if (removed) void this.save();
    return removed;
  }

  isDeviceToken(token: string): boolean {
    return this.devices.some((d) => d.token === token);
  }

  async flush(): Promise<void> {
    await this.saveChain;
  }

  private save(): void {
    this.saveChain = this.saveChain
      .then(async () => {
        const dir = dirname(this.file);
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, 'devices.jsonl.tmp');
        await writeFile(tmp, this.devices.map((d) => JSON.stringify(d)).join('\n'), 'utf8');
        await rename(tmp, this.file);
      })
      .catch((err) => {
        console.error(`[fraktole] failed to persist devices: ${String(err)}`);
      });
  }
}
