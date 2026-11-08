import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HistoryEntry } from '@brain/shared';
import { badRequest, notFound } from './errors.js';
import { utf8ByteLength } from './text.js';

export interface HistoryStore {
  save(path: string, content: string): Promise<string>;
  list(path: string): Promise<HistoryEntry[]>;
  get(path: string, id: string): Promise<string>;
  move(from: string, to: string): Promise<void>;
}

const ID_RE = /^\d{8}T\d{9}Z(-\d{1,3})?$/;

export function assertHistoryId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw badRequest('Id di versione non valido.');
  return id;
}

function idToIso(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(id);
  if (!m) return new Date(0).toISOString();
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
}

export class FsHistoryStore implements HistoryStore {
  constructor(
    private readonly dir: string,
    private readonly maxPerFile = 20,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private folder(rel: string): string {
    return path.join(this.dir, ...rel.split('/'));
  }

  async save(rel: string, content: string): Promise<string> {
    const folder = this.folder(rel);
    await fs.mkdir(folder, { recursive: true });
    const base = this.now().toISOString().replace(/[-:.]/g, '');
    let id = base;
    for (let n = 1; n < 1000; n++) {
      try {
        await fs.writeFile(path.join(folder, id), content, { encoding: 'utf8', flag: 'wx' });
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== 'EEXIST') throw e;
        id = `${base}-${n}`;
      }
    }
    await this.prune(folder);
    return id;
  }

  private async ids(folder: string): Promise<string[]> {
    try {
      const names = await fs.readdir(folder, { withFileTypes: true });
      return names
        .filter((d) => d.isFile() && ID_RE.test(d.name))
        .map((d) => d.name)
        .sort(compareIds);
    } catch {
      return [];
    }
  }

  private async prune(folder: string): Promise<void> {
    const ids = await this.ids(folder);
    const excess = ids.length - this.maxPerFile;
    for (let i = 0; i < excess; i++) {
      await fs.rm(path.join(folder, ids[i]!), { force: true });
    }
  }

  async list(rel: string): Promise<HistoryEntry[]> {
    const folder = this.folder(rel);
    const ids = await this.ids(folder);
    const entries: HistoryEntry[] = [];
    for (const id of ids.reverse()) {
      const st = await fs.stat(path.join(folder, id)).catch(() => null);
      if (st) entries.push({ id, size: st.size, createdAt: idToIso(id) });
    }
    return entries;
  }

  async get(rel: string, id: string): Promise<string> {
    assertHistoryId(id);
    try {
      return await fs.readFile(path.join(this.folder(rel), id), 'utf8');
    } catch {
      throw notFound('Versione non trovata nello storico.');
    }
  }

  async move(from: string, to: string): Promise<void> {
    if (from === to) return;
    const src = this.folder(from);
    const dst = this.folder(to);
    try {
      await fs.access(src);
    } catch {
      return;
    }
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      if (from.toLowerCase() === to.toLowerCase()) {
        const tmp = `${src}.__brain_hist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        await fs.rename(src, tmp);
        await fs.rename(tmp, dst);
      } else {
        await fs.rename(src, dst);
      }
    } catch {
      // ignore
    }
  }
}

function compareIds(a: string, b: string): number {
  const [ab, an] = a.split('-');
  const [bb, bn] = b.split('-');
  if (ab !== bb) return ab! < bb! ? -1 : 1;
  return Number(an ?? 0) - Number(bn ?? 0);
}

export class MemoryHistoryStore implements HistoryStore {
  private records = new Map<string, Array<{ id: string; content: string; createdAt: string; size: number }>>();

  constructor(
    private readonly maxPerFile = 20,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async save(rel: string, content: string): Promise<string> {
    const list = this.records.get(rel) ?? [];
    const base = this.now().toISOString().replace(/[-:.]/g, '');
    let id = base;
    let n = 1;
    while (list.some((e) => e.id === id)) {
      id = `${base}-${n++}`;
    }
    const entry = {
      id,
      content,
      createdAt: idToIso(id),
      size: utf8ByteLength(content),
    };
    list.unshift(entry);
    while (list.length > this.maxPerFile) {
      list.pop();
    }
    this.records.set(rel, list);
    return id;
  }

  async list(rel: string): Promise<HistoryEntry[]> {
    const list = this.records.get(rel) ?? [];
    return list.map((e) => ({
      id: e.id,
      size: e.size,
      createdAt: e.createdAt,
    }));
  }

  async get(rel: string, id: string): Promise<string> {
    const list = this.records.get(rel) ?? [];
    const found = list.find((e) => e.id === id);
    if (!found) throw notFound('Versione non trovata nello storico.');
    return found.content;
  }

  async move(from: string, to: string): Promise<void> {
    if (from === to) return;
    const fromLower = from.toLowerCase();
    const prefixLower = fromLower + '/';
    for (const [k, v] of [...this.records.entries()]) {
      const kLower = k.toLowerCase();
      if (kLower === fromLower) {
        this.records.delete(k);
        this.records.set(to, v);
      } else if (kLower.startsWith(prefixLower)) {
        this.records.delete(k);
        this.records.set(to + '/' + k.slice(from.length + 1), v);
      }
    }
  }
}
