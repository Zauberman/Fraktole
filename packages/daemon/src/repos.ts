import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FraktoleConfig, RepoConfig } from '@fraktole/core';

const execFileP = promisify(execFile);

/**
 * The daemon-owned list of registered repositories. Adds are validated with
 * `git rev-parse --show-toplevel` and persisted back into the config file.
 */
export class RepoRegistry {
  constructor(
    private readonly configPath: string,
    private readonly config: FraktoleConfig,
  ) {}

  list(): RepoConfig[] {
    return [...this.config.repos];
  }

  async add(path: string): Promise<RepoConfig> {
    const root = await this.resolveRoot(path);
    const existing = this.config.repos.find((r) => r.path === root);
    if (existing) return existing;
    const repo: RepoConfig = { path: root, defaultBranch: 'main', allowPush: false };
    this.config.repos.push(repo);
    await this.persist();
    return repo;
  }

  async remove(path: string): Promise<boolean> {
    const root = await this.resolveRoot(path).catch(() => path);
    const before = this.config.repos.length;
    this.config.repos = this.config.repos.filter((r) => r.path !== root);
    const removed = this.config.repos.length < before;
    if (removed) await this.persist();
    return removed;
  }

  /**
   * Git toplevel when the path is inside a repo, otherwise the absolute path:
   * plain directories are valid targets (agents run in place).
   */
  private async resolveRoot(path: string): Promise<string> {
    try {
      const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], {
        cwd: path,
      });
      return stdout.trim();
    } catch {
      return resolve(path);
    }
  }

  private async persist(): Promise<void> {
    await writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
  }
}
