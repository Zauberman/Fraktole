import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { Project } from '../src/shared/ipc.js';

const execFileP = promisify(execFile);

/**
 * The app-owned project list, persisted as JSON under userData.
 * Adds resolve to the git toplevel when inside a repo, else the absolute
 * path — the directory where the user fires agents.
 */
export class ProjectsStore {
  constructor(private readonly file: string) {}

  async list(): Promise<Project[]> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as { projects: Project[] };
      if (!Array.isArray(parsed.projects)) return [];
      return [...parsed.projects].sort((a, b) => b.lastUsed - a.lastUsed);
    } catch {
      return [];
    }
  }

  async add(path: string): Promise<Project> {
    const abs = resolve(path);
    const root = await this.gitTopLevel(abs).catch(() => abs);
    const all = await this.list();
    const existing = all.find((p) => p.path === root);
    const project: Project = existing
      ? { ...existing, lastUsed: Date.now() }
      : { path: root, name: basename(root), lastUsed: Date.now() };
    const next = existing
      ? all.map((p) => (p.path === root ? project : p))
      : [...all, project];
    await this.persist(next);
    return project;
  }

  /** Binds a project to its session (1:1). */
  async bindSession(path: string, sessionId: string): Promise<Project | null> {
    const root = await this.gitTopLevel(path).catch(() => resolve(path));
    const all = await this.list();
    const existing = all.find((p) => p.path === root);
    if (!existing) return null;
    const bound: Project = { ...existing, sessionId };
    await this.persist(all.map((p) => (p.path === root ? bound : p)));
    return bound;
  }

  async remove(path: string): Promise<boolean> {
    const root = await this.gitTopLevel(path).catch(() => resolve(path));
    const all = await this.list();
    const next = all.filter((p) => p.path !== root);
    if (next.length === all.length) return false;
    await this.persist(next);
    return true;
  }

  private async persist(projects: Project[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const sorted = [...projects].sort((a, b) => b.lastUsed - a.lastUsed);
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ projects: sorted }, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  private async gitTopLevel(path: string): Promise<string> {
    const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd: path });
    const top = stdout.trim();
    return top.length > 0 ? top : resolve(path);
  }
}
