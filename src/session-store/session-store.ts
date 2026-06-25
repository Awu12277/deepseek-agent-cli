import { mkdir, readFile, writeFile, readdir, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { StoredSession, SessionSummary } from "./types.js";

export function defaultSessionsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return join(home, ".dskcode", "sessions");
}

export class SessionStore {
  readonly #dir: string;
  constructor(dir?: string) { this.#dir = dir ?? defaultSessionsDir(); }
  get dir(): string { return this.#dir; }

  async save(session: StoredSession): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const finalPath = join(this.#dir, `${session.id}.json`);
    const tmpPath = join(this.#dir, `.${session.id}.json.tmp`);
    await writeFile(tmpPath, JSON.stringify(session, null, 2), "utf-8");
    await rename(tmpPath, finalPath);
  }

  async load(id: string): Promise<StoredSession | null> {
    const path = join(this.#dir, `${id}.json`);
    try {
      const content = await readFile(path, "utf-8");
      return JSON.parse(content) as StoredSession;
    } catch (err: unknown) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  async list(): Promise<SessionSummary[]> {
    let files: string[];
    try { files = await readdir(this.#dir); }
    catch (err: unknown) { if (isENOENT(err)) return []; throw err; }

    const results: SessionSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      try {
        const content = await readFile(join(this.#dir, file), "utf-8");
        const s = JSON.parse(content) as StoredSession;
        results.push({
          id: s.id, title: s.title || "（无标题）", updatedAt: s.updatedAt,
          cwd: s.cwd, messageCount: s.messages?.length ?? 0,
        });
      } catch { /* skip corrupted */ }
    }
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(id: string): Promise<void> {
    const path = join(this.#dir, `${id}.json`);
    try { await unlink(path); }
    catch (err: unknown) { if (!isENOENT(err)) throw err; }
  }

  async exists(id: string): Promise<boolean> { return (await this.load(id)) !== null; }
  static newId(): string { return randomUUID(); }
}

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}
