import type { HistoryEntry, GithubSyncProfile } from '@brain/shared';
import { conflict, forbidden, notFound } from '../errors.js';
import type { HistoryStore } from '../history.js';
import { computeVersion, detectEol, utf8ByteLength } from '../text.js';
import { MemoryStorage } from './memory-storage.js';
import type { Storage, StorageEntry, WriteOptions } from './storage.js';

export interface GithubCommitRecord {
  sha: string;
  path: string;
  content: string;
  message: string;
  createdAt: string;
  size: number;
}

export interface GithubBackendOptions {
  profile?: GithubSyncProfile;
  maxCommitsPerFile?: number;
  now?: () => Date;
  /** Se true, le chiamate a list() rimuovono il prefisso 'kb/' per i consumatori interni come KbService. Default: true. */
  stripPrefixForKbService?: boolean;
}

const DEFAULT_PROFILE: GithubSyncProfile = {
  nome: 'second-brain',
  owner: 'aleg888-tech',
  repo: 'second-brain',
  branch: 'main',
  percorsoKb: 'kb',
};

/**
 * Implementazione pura (zero `node:*`) di `Storage` + `HistoryStore` per GitHub monorepo.
 * Tutte le operazioni di scrittura/lettura/commit sono vincolate alla cartella `percorsoKb` (default 'kb/').
 * Include guardrail hard contro path traversal e scritture su codice/webapp/.
 */
export class GithubBackend implements Storage, HistoryStore {
  readonly profile: GithubSyncProfile;
  private readonly inner = new MemoryStorage();
  private readonly commitsByPath = new Map<string, GithubCommitRecord[]>();
  private readonly maxCommitsPerFile: number;
  private readonly now: () => Date;
  private readonly stripPrefixForKbService: boolean;
  private commitCounter = 1;

  constructor(
    optsOrMaxCommits: GithubBackendOptions | GithubSyncProfile | number = 50,
    nowFn?: () => Date,
  ) {
    if (typeof optsOrMaxCommits === 'number') {
      this.profile = { ...DEFAULT_PROFILE };
      this.maxCommitsPerFile = optsOrMaxCommits;
      this.now = nowFn ?? (() => new Date());
      this.stripPrefixForKbService = true;
    } else if ('owner' in optsOrMaxCommits && 'repo' in optsOrMaxCommits) {
      const pKb = (optsOrMaxCommits as GithubSyncProfile).percorsoKb || 'kb';
      this.profile = {
        ...(optsOrMaxCommits as GithubSyncProfile),
        percorsoKb: pKb,
      };
      this.maxCommitsPerFile = 50;
      this.now = nowFn ?? (() => new Date());
      this.stripPrefixForKbService = true;
    } else {
      const opts = optsOrMaxCommits as GithubBackendOptions;
      this.profile = {
        ...DEFAULT_PROFILE,
        ...(opts.profile ?? {}),
      };
      this.maxCommitsPerFile = opts.maxCommitsPerFile ?? 50;
      this.now = opts.now ?? nowFn ?? (() => new Date());
      this.stripPrefixForKbService = opts.stripPrefixForKbService ?? true;
    }
  }

  get percorsoKb(): string {
    return this.profile.percorsoKb || 'kb';
  }

  /**
   * Formatta un messaggio di commit assicurando il prefisso 'kb:'.
   */
  formatCommitMessage(message: string): string {
    const trimmed = (message || '').trim();
    if (!trimmed) return 'kb: aggiornamento contenuto';
    if (/^kb:\s*/i.test(trimmed)) {
      return `kb: ${trimmed.replace(/^kb:\s*/i, '')}`;
    }
    return `kb: ${trimmed}`;
  }

  /**
   * Guardrail di sicurezza per i percorsi:
   * 1. Blocca path traversal ('..', '//', percorsi assoluti).
   * 2. Rifiuta esplicitamente path diretti a cartelle protette come 'webapp', '.github', 'node_modules'.
   * 3. Rifiuta qualsiasi path che esca o non appartenga a `percorsoKb`.
   * Restituisce sempre il percorso normalizzato con prefisso `${percorsoKb}/...`.
   */
  validatePath(rawPath: string, isWrite = false): string {
    if (!rawPath || typeof rawPath !== 'string') {
      throw forbidden('Percorso non valido o vuoto.');
    }

    const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '').trim();

    // Rifiuta path traversal
    const segments = normalized.split('/');
    if (segments.some((s) => s === '..' || s === '.')) {
      throw forbidden(`Path traversal non consentito: "${rawPath}".`);
    }

    // Rifiuta esplicitamente cartelle protette di codice o configurazione
    const protectedDirs = ['webapp', '.github', 'node_modules', '.brain'];
    if (protectedDirs.includes(segments[0].toLowerCase())) {
      throw forbidden(
        `[GUARD DI SICUREZZA] Scrittura/lettura vietata su "${segments[0]}": l'app puo operare SOLO sotto "${this.percorsoKb}/".`,
      );
    }

    const kbPrefix = `${this.percorsoKb}/`;
    if (normalized === this.percorsoKb) {
      return this.percorsoKb;
    }

    if (normalized.startsWith(kbPrefix)) {
      return normalized;
    }

    // Se un chiamante esterno tenta una scrittura fornendo un path che non inizia con 'kb/' e non è relativo alla KB
    if (isWrite && (rawPath.startsWith('/') || rawPath.startsWith('\\') || rawPath.includes(':'))) {
      throw forbidden(`Scrittura rifiutata: il percorso deve iniziare con "${this.percorsoKb}/".`);
    }

    // Prefissa con percorsoKb
    return `${this.percorsoKb}/${normalized}`;
  }

  /**
   * Verifica lo SHA dell'albero di 'kb/' dal tree remoto di GitHub.
   * Evita conflitti spuri quando vengono committate modifiche su 'webapp/' o '.github/'.
   */
  getRemoteTreeSha(tree: Array<{ path: string; sha: string; type?: string }>): string | null {
    if (!Array.isArray(tree)) return null;

    // 1. Cerca il nodo albero diretto con path === percorsoKb
    const kbSubtree = tree.find(
      (entry) => entry.path === this.percorsoKb && (entry.type === 'tree' || !entry.type),
    );
    if (kbSubtree?.sha) {
      return kbSubtree.sha;
    }

    // 2. In alternativa, se l'albero è piatto, calcola/filtra gli sha dei file sotto percorsoKb/
    const kbFiles = tree
      .filter((e) => e.path.startsWith(`${this.percorsoKb}/`))
      .sort((a, b) => a.path.localeCompare(b.path));

    if (kbFiles.length === 0) return null;
    return kbFiles.map((f) => `${f.path}:${f.sha}`).join(';');
  }

  // --- Storage Implementation ---

  list(): Promise<StorageEntry[]>;
  list(path: string): Promise<HistoryEntry[]>;
  async list(path?: string): Promise<StorageEntry[] | HistoryEntry[]> {
    if (typeof path === 'string') {
      return this.listCommits(path);
    }

    const allEntries = await this.inner.list();
    const prefix = `${this.percorsoKb}/`;
    const kbEntries = allEntries.filter((e) => e.path.startsWith(prefix) || e.path === this.percorsoKb);

    if (!this.stripPrefixForKbService) {
      return kbEntries;
    }

    // Rimuove il prefisso per i consumatori interni (KbService, TableEngine, ecc.)
    return kbEntries.map((e) => {
      let stripped = e.path;
      if (stripped.startsWith(prefix)) {
        stripped = stripped.slice(prefix.length);
      } else if (stripped === this.percorsoKb) {
        stripped = '';
      }
      return {
        ...e,
        path: stripped,
      };
    }).filter((e) => e.path.length > 0);
  }

  /** Restituisce tutte le voci con i percorsi completi (prefisso 'kb/' compreso). */
  async rawList(): Promise<StorageEntry[]> {
    return this.inner.list();
  }

  async stat(rawPath: string): Promise<StorageEntry | null> {
    const fullPath = this.validatePath(rawPath);
    const res = await this.inner.stat(fullPath);
    if (!res) return null;
    if (this.stripPrefixForKbService && res.path.startsWith(`${this.percorsoKb}/`)) {
      return { ...res, path: res.path.slice(this.percorsoKb.length + 1) };
    }
    return res;
  }

  async read(rawPath: string) {
    const fullPath = this.validatePath(rawPath);
    return this.inner.read(fullPath);
  }

  async write(rawPath: string, content: string, opts: WriteOptions = {}): Promise<StorageEntry> {
    const fullPath = this.validatePath(rawPath, true);
    const current = await this.inner.read(fullPath);
    if (opts.baseVersion !== undefined) {
      const curVersion = await computeVersion(current.content);
      if (curVersion !== opts.baseVersion) {
        throw conflict('Il file è stato modificato nel frattempo sul branch remoto.', {
          path: rawPath,
          content: current.content,
          version: curVersion,
          eol: detectEol(current.content),
          size: current.size,
          mtimeMs: current.mtimeMs,
        });
      }
    }
    const written = await this.inner.write(fullPath, content, opts);
    if (this.stripPrefixForKbService && written.path.startsWith(`${this.percorsoKb}/`)) {
      return { ...written, path: written.path.slice(this.percorsoKb.length + 1) };
    }
    return written;
  }

  async create(rawPath: string, content: string): Promise<StorageEntry> {
    const fullPath = this.validatePath(rawPath, true);
    const created = await this.inner.create(fullPath, content);
    if (this.stripPrefixForKbService && created.path.startsWith(`${this.percorsoKb}/`)) {
      return { ...created, path: created.path.slice(this.percorsoKb.length + 1) };
    }
    return created;
  }

  async createDir(rawPath: string): Promise<void> {
    const fullPath = this.validatePath(rawPath, true);
    return this.inner.createDir(fullPath);
  }

  async rename(rawFrom: string, rawTo: string): Promise<void> {
    const fullFrom = this.validatePath(rawFrom, true);
    const fullTo = this.validatePath(rawTo, true);
    await this.inner.rename(fullFrom, fullTo);
    await this.move(fullFrom, fullTo);
  }

  async archive(rawPath: string, rawArchiveDir: string): Promise<string> {
    const fullPath = this.validatePath(rawPath, true);
    const fullArchiveDir = this.validatePath(rawArchiveDir, true);
    const archivedPath = await this.inner.archive(fullPath, fullArchiveDir);
    await this.move(fullPath, archivedPath);
    if (this.stripPrefixForKbService && archivedPath.startsWith(`${this.percorsoKb}/`)) {
      return archivedPath.slice(this.percorsoKb.length + 1);
    }
    return archivedPath;
  }

  async delete(rawPath: string): Promise<void> {
    const fullPath = this.validatePath(rawPath, true);
    return this.inner.delete(fullPath);
  }

  // --- HistoryStore Implementation ---

  async save(rawPath: string, content: string, commitMsg?: string): Promise<string> {
    const fullPath = this.validatePath(rawPath, true);
    const list = this.commitsByPath.get(fullPath) ?? [];
    const base = this.now().toISOString().replace(/[-:.]/g, '');
    const id = `${base}-${this.commitCounter++}`;
    const rec: GithubCommitRecord = {
      sha: id,
      path: fullPath,
      content,
      message: this.formatCommitMessage(commitMsg || 'aggiornamento'),
      createdAt: this.now().toISOString(),
      size: utf8ByteLength(content),
    };
    list.unshift(rec);
    while (list.length > this.maxCommitsPerFile) {
      list.pop();
    }
    this.commitsByPath.set(fullPath, list);
    return id;
  }

  async listCommits(rawPath: string): Promise<HistoryEntry[]> {
    const fullPath = this.validatePath(rawPath);
    const list = this.commitsByPath.get(fullPath) ?? [];
    return list.map((c) => ({
      id: c.sha,
      size: c.size,
      createdAt: c.createdAt,
    }));
  }

  async get(rawPath: string, id: string): Promise<string> {
    const fullPath = this.validatePath(rawPath);
    const list = this.commitsByPath.get(fullPath) ?? [];
    const hit = list.find((c) => c.sha === id);
    if (!hit) throw notFound('Commit non trovato nello storico.');
    return hit.content;
  }

  async move(rawFrom: string, rawTo: string): Promise<void> {
    const fullFrom = this.validatePath(rawFrom, true);
    const fullTo = this.validatePath(rawTo, true);
    if (fullFrom === fullTo) return;
    const fromLower = fullFrom.toLowerCase();
    const prefixLower = fromLower + '/';
    for (const [k, v] of [...this.commitsByPath.entries()]) {
      const kLower = k.toLowerCase();
      if (kLower === fromLower) {
        this.commitsByPath.delete(k);
        this.commitsByPath.set(fullTo, v);
      } else if (kLower.startsWith(prefixLower)) {
        this.commitsByPath.delete(k);
        this.commitsByPath.set(fullTo + '/' + k.slice(fullFrom.length + 1), v);
      }
    }
  }

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
}
