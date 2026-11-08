import type { HistoryEntry } from '@brain/shared';
import { conflict, notFound } from '../errors.js';
import type { HistoryStore } from '../history.js';
import { computeVersion, detectEol, utf8ByteLength } from '../text.js';
import { MemoryStorage } from './memory-storage.js';
import type { Storage, StorageEntry, WriteOptions } from './storage.js';

export interface GithubCommitRecord {
  sha: string;
  path: string;
  content: string;
  createdAt: string;
  size: number;
}

/**
 * Implementazione pura (zero `node:*`) di `Storage` + `HistoryStore` che modella un repository
 * GitHub/Git con controllo di versione basato su SHA, commit history per file e stesse garanzie
 * transazionali di `FsBackend`. Usata per verificare il contratto multi-backend su `kb-core`.
 */
export class GithubBackend implements Storage, HistoryStore {
  private readonly inner = new MemoryStorage();
  private readonly commitsByPath = new Map<string, GithubCommitRecord[]>();
  private commitCounter = 1;

  constructor(
    private readonly maxCommitsPerFile = 50,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): Promise<StorageEntry[]>;
  list(path: string): Promise<HistoryEntry[]>;
  list(path?: string): Promise<StorageEntry[] | HistoryEntry[]> {
    if (typeof path === 'string') {
      return this.listCommits(path);
    }
    return this.inner.list();
  }

  stat(path: string): Promise<StorageEntry | null> {
    return this.inner.stat(path);
  }

  read(path: string) {
    return this.inner.read(path);
  }

  async write(path: string, content: string, opts: WriteOptions = {}): Promise<StorageEntry> {
    const current = await this.inner.read(path);
    if (opts.baseVersion !== undefined) {
      const curVersion = await computeVersion(current.content);
      if (curVersion !== opts.baseVersion) {
        throw conflict('Il file è stato modificato nel frattempo sul branch remoto.', {
          path,
          content: current.content,
          version: curVersion,
          eol: detectEol(current.content),
          size: current.size,
          mtimeMs: current.mtimeMs,
        });
      }
    }
    return this.inner.write(path, content, opts);
  }

  create(path: string, content: string): Promise<StorageEntry> {
    return this.inner.create(path, content);
  }

  createDir(path: string): Promise<void> {
    return this.inner.createDir(path);
  }

  rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to);
  }

  archive(path: string, archiveDir: string): Promise<string> {
    return this.inner.archive(path, archiveDir);
  }

  delete(path: string): Promise<void> {
    return this.inner.delete(path);
  }

  // HistoryStore (commit log per file)
  async save(rel: string, content: string): Promise<string> {
    const list = this.commitsByPath.get(rel) ?? [];
    const base = this.now().toISOString().replace(/[-:.]/g, '');
    const id = `${base}-${this.commitCounter++}`;
    const rec: GithubCommitRecord = {
      sha: id,
      path: rel,
      content,
      createdAt: this.now().toISOString(),
      size: utf8ByteLength(content),
    };
    list.unshift(rec);
    while (list.length > this.maxCommitsPerFile) {
      list.pop();
    }
    this.commitsByPath.set(rel, list);
    return id;
  }

  async listCommits(rel: string): Promise<HistoryEntry[]> {
    const list = this.commitsByPath.get(rel) ?? [];
    return list.map((c) => ({
      id: c.sha,
      size: c.size,
      createdAt: c.createdAt,
    }));
  }

  // Nota: `HistoryStore.list` e `Storage.list` hanno lo stesso nome di metodo con firma diversa,
  // quindi esponiamo `.storage` e `.history` (oltre ai metodi diretti) per `KbService`.
  get storage(): Storage {
    return this;
  }

  get history(): HistoryStore {
    return {
      save: (rel, content) => this.save(rel, content),
      list: (rel) => this.listCommits(rel),
      get: (rel, id) => this.get(rel, id),
      move: (from, to) => this.move(from, to),
    };
  }

  async get(rel: string, id: string): Promise<string> {
    const list = this.commitsByPath.get(rel) ?? [];
    const hit = list.find((c) => c.sha === id);
    if (!hit) throw notFound('Commit non trovato nello storico.');
    return hit.content;
  }

  async move(from: string, to: string): Promise<void> {
    if (from === to) return;
    const fromLower = from.toLowerCase();
    const prefixLower = fromLower + '/';
    for (const [k, v] of [...this.commitsByPath.entries()]) {
      const kLower = k.toLowerCase();
      if (kLower === fromLower) {
        this.commitsByPath.delete(k);
        this.commitsByPath.set(to, v);
      } else if (kLower.startsWith(prefixLower)) {
        this.commitsByPath.delete(k);
        this.commitsByPath.set(to + '/' + k.slice(from.length + 1), v);
      }
    }
  }
}
