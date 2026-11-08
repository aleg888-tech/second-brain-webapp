import type {
  FileContent,
  FileMeta,
  FrontmatterPatchResponse,
  HistoryEntry,
  LinksResponse,
  MoveResult,
  SearchHit,
  SearchResponse,
  StatusResponse,
  TagInfo,
  TreeEntry,
  WriteResult,
} from '@brain/shared';
import { alreadyExists, AppError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { patchFrontmatterField, type PatchFrontmatterOptions } from './frontmatter-patch.js';
import { assertHistoryId, type HistoryStore } from './history.js';
import { FrontmatterIndexer } from './indexers/frontmatter-index.js';
import { LinkTagIndexer } from './indexers/link-index.js';
import { IndexerRegistry, type Indexer } from './indexers/registry.js';
import { cleanConfigDir, extOf, isUnder, joinRel, normalizeRelPath } from './storage/paths.js';
import type { Storage, StorageEntry } from './storage/storage.js';
import { applyEol, computeSignature, computeVersion, detectEol, localDate, toLf } from './text.js';

export const ARCHIVE_DIR = '_archivio';
export const ATTACHMENTS_DIR = 'allegati';
export const VIRTUAL_INDEX_VERSION = 'virtual-empty-index';
const MAX_FILE_CHARS = 5_000_000;
const MAX_QUERY_CHARS = 200;

export interface KbServiceOptions {
  storage: Storage;
  history: HistoryStore;
  extensions: string[];
  exclude: string[];
  agentDeny?: string[];
  indexers?: Indexer[];
  now?: () => Date;
}

export interface SearchOptions {
  includeArchived?: boolean;
  filter?: (path: string) => boolean;
  limit?: number;
}

export function isPathDenied(path: string, agentDeny: readonly string[]): boolean {
  if (!agentDeny || agentDeny.length === 0) return false;
  const normalized = normalizeRelPath(path, { kind: 'any', allowRoot: true, extensions: [] });
  for (const denied of agentDeny) {
    const clean = cleanConfigDir(denied);
    if (normalized === clean || isUnder(normalized, clean)) {
      return true;
    }
  }
  return false;
}

export class KbService {
  readonly archiveDir = ARCHIVE_DIR;
  readonly extensions: readonly string[];
  readonly agentDeny: readonly string[];
  readonly indexers = new IndexerRegistry();
  readonly links = new LinkTagIndexer();
  readonly frontmatter = new FrontmatterIndexer();

  private readonly storage: Storage;
  private readonly history: HistoryStore;
  private readonly now: () => Date;
  private readonly hiddenAlways: Set<string>;
  private readonly archiveHidden: boolean;

  private known = new Map<string, { size: number; mtimeMs: number }>();
  private entries: TreeEntry[] = [];
  private signature = '';
  private running: Promise<void> | null = null;
  private pending: Promise<void> | null = null;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(opts: KbServiceOptions) {
    this.storage = opts.storage;
    this.history = opts.history;
    this.now = opts.now ?? (() => new Date());
    this.extensions = opts.extensions.map((e) => e.toLowerCase());
    this.agentDeny = (opts.agentDeny ?? []).map(cleanConfigDir);
    const exclude = opts.exclude.map((e) => e.toLowerCase());
    this.archiveHidden = exclude.includes(ARCHIVE_DIR);
    this.hiddenAlways = new Set(exclude.filter((e) => e !== ARCHIVE_DIR));
    this.indexers.register(this.links);
    this.indexers.register(this.frontmatter);
    for (const ix of opts.indexers ?? []) this.indexers.register(ix);
  }

  isPathDenied(path: string): boolean {
    return isPathDenied(path, this.agentDeny);
  }

  assertNotDenied(path: string): void {
    if (this.isPathDenied(path)) {
      throw forbidden(`Accesso negato: "${path}" è protetto da agentDeny.`);
    }
  }

  filePath(input: unknown): string {
    return normalizeRelPath(input, { kind: 'file', extensions: this.extensions });
  }

  dirPath(input: unknown, allowRoot = false): string {
    return normalizeRelPath(input, { kind: 'dir', extensions: this.extensions, allowRoot });
  }

  anyPath(input: unknown): string {
    return normalizeRelPath(input, { kind: 'any', extensions: this.extensions });
  }

  isArchived(path: string): boolean {
    return isUnder(path, ARCHIVE_DIR);
  }

  private isAlwaysHidden(path: string): boolean {
    return path.split('/').some((s) => this.hiddenAlways.has(s.toLowerCase()));
  }

  refresh(): Promise<void> {
    if (!this.running) {
      this.running = this.scan().finally(() => {
        this.running = null;
      });
      return this.running;
    }
    this.pending ??= this.running
      .catch(() => undefined)
      .then(() => {
        this.pending = null;
        return this.refresh();
      });
    return this.pending;
  }

  private async scan(): Promise<void> {
    const raw = await this.storage.list();
    const entries: TreeEntry[] = [];
    for (const e of raw) {
      if (this.isAlwaysHidden(e.path)) continue;
      if (e.type === 'file' && !this.extensions.includes(extOf(e.path))) continue;
      entries.push({ ...e, archived: this.isArchived(e.path) });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const seen = new Set<string>();
    for (const e of entries) {
      if (e.type !== 'file') continue;
      seen.add(e.path);
      const prev = this.known.get(e.path);
      if (prev && prev.size === e.size && prev.mtimeMs === e.mtimeMs) continue;
      if (this.indexers.wants(e.path)) {
        try {
          const f = await this.storage.read(e.path);
          this.indexers.upsert({ path: e.path, content: f.content, archived: e.archived });
        } catch {
          continue;
        }
      }
      this.known.set(e.path, { size: e.size, mtimeMs: e.mtimeMs });
    }
    for (const p of [...this.known.keys()]) {
      if (!seen.has(p)) {
        this.known.delete(p);
        this.indexers.remove(p);
      }
    }
    this.entries = entries;
    this.signature = await computeSignature(
      entries.map((e) => `${e.type}|${e.path}|${e.size}|${Math.round(e.mtimeMs)}`),
    );
  }

  private noteWritten(path: string, content: string, entry: StorageEntry): void {
    if (this.indexers.wants(path)) {
      this.indexers.upsert({ path, content, archived: this.isArchived(path) });
    }
    this.known.set(path, { size: entry.size, mtimeMs: entry.mtimeMs });
  }

  async status(): Promise<StatusResponse> {
    await this.refresh();
    return { signature: this.signature, files: this.entries.filter((e) => e.type === 'file').length };
  }

  async tree(includeArchived = false): Promise<TreeEntry[]> {
    await this.refresh();
    if (includeArchived || !this.archiveHidden) return [...this.entries];
    return this.entries.filter((e) => !e.archived);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const k = key.toLowerCase();
    const prev = this.locks.get(k) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(k, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(k) === tail) this.locks.delete(k);
    }
  }

  private static checkContent(content: unknown): string {
    if (typeof content !== 'string') throw badRequest('Contenuto mancante o non valido.');
    if (content.length > MAX_FILE_CHARS) throw badRequest('File troppo grande.');
    return content;
  }

  private async meta(path: string, content: string, entry: StorageEntry): Promise<FileMeta> {
    return {
      path,
      version: await computeVersion(content),
      eol: detectEol(content),
      size: entry.size,
      mtimeMs: entry.mtimeMs,
    };
  }

  async read(input: unknown): Promise<FileContent> {
    const path = this.filePath(input);
    const f = await this.storage.read(path);
    return {
      path,
      content: f.content,
      version: await computeVersion(f.content),
      eol: detectEol(f.content),
      size: f.size,
      mtimeMs: f.mtimeMs,
    };
  }

  /**
   * Legge un file esistente oppure, se viene richiesto `<cartella>/_index.md` per una cartella
   * esistente ancora priva di `_index.md`, restituisce un documento virtuale vuoto SENZA
   * creare alcun file su disco.
   */
  async readOrVirtualIndex(input: unknown): Promise<FileContent> {
    const path = this.filePath(input);
    try {
      return await this.read(path);
    } catch (err) {
      if (
        err instanceof AppError &&
        err.code === 'not_found' &&
        path.toLowerCase().endsWith('/_index.md')
      ) {
        const dir = path.slice(0, -'/_index.md'.length);
        const dirEntry = await this.storage.stat(dir);
        if (dirEntry && dirEntry.type === 'dir') {
          return {
            path,
            content: '',
            version: VIRTUAL_INDEX_VERSION,
            eol: 'lf',
            size: 0,
            mtimeMs: dirEntry.mtimeMs,
            virtual: true,
          };
        }
      }
      throw err;
    }
  }

  async write(input: unknown, contentIn: unknown, baseVersion: unknown): Promise<WriteResult> {
    const path = this.filePath(input);
    const content = KbService.checkContent(contentIn);
    if (typeof baseVersion !== 'string' || baseVersion === '') {
      throw badRequest('baseVersion mancante: rileggi il file prima di salvarlo.');
    }
    return this.withLock(path, async () => {
      const existingStat = await this.storage.stat(path);
      if (!existingStat && baseVersion === VIRTUAL_INDEX_VERSION && path.toLowerCase().endsWith('/_index.md')) {
        const dir = path.slice(0, -'/_index.md'.length);
        const dirStat = await this.storage.stat(dir);
        if (!dirStat || dirStat.type !== 'dir') {
          throw notFound(`La cartella "${dir}" non esiste.`);
        }
        const final = toLf(content);
        if (final === '') {
          return {
            file: {
              path,
              version: VIRTUAL_INDEX_VERSION,
              eol: 'lf',
              size: 0,
              mtimeMs: dirStat.mtimeMs,
              virtual: true,
            },
            historyId: null,
          };
        }
        const entry = await this.storage.create(path, final);
        this.noteWritten(path, final, entry);
        await this.refresh();
        return { file: await this.meta(path, final, entry), historyId: null };
      }

      const cur = await this.read(path);
      if (cur.version !== baseVersion) {
        throw conflict('Il file è stato modificato nel frattempo.', cur);
      }
      const final = applyEol(content, cur.eol);
      if (final === cur.content) return { file: toMeta(cur), historyId: null };
      const historyId = await this.history.save(path, cur.content);
      const entry = await this.storage.write(path, final, { baseVersion });
      this.noteWritten(path, final, entry);
      return { file: await this.meta(path, final, entry), historyId };
    });
  }

  async patchFrontmatter(
    input: unknown,
    key: string,
    value: unknown,
    baseVersion: unknown,
    opts: PatchFrontmatterOptions = {},
  ): Promise<FrontmatterPatchResponse> {
    const path = this.filePath(input);
    if (!path.toLowerCase().endsWith('.md')) {
      throw badRequest('Il frontmatter YAML è supportato solo sui file .md.');
    }
    if (typeof baseVersion !== 'string' || baseVersion === '') {
      throw badRequest('baseVersion mancante: rileggi il file prima di salvarlo.');
    }
    return this.withLock(path, async () => {
      const cur = await this.readOrVirtualIndex(path);
      if (cur.version !== baseVersion) {
        throw conflict('Il file è stato modificato nel frattempo.', cur);
      }
      const patched = patchFrontmatterField(cur.content, key, value, opts);
      if (patched === cur.content) {
        return { file: toMeta(cur), historyId: null, content: cur.content };
      }
      if (cur.virtual) {
        const entry = await this.storage.create(path, patched);
        this.noteWritten(path, patched, entry);
        await this.refresh();
        return {
          file: await this.meta(path, patched, entry),
          historyId: null,
          content: patched,
        };
      }
      const historyId = await this.history.save(path, cur.content);
      const entry = await this.storage.write(path, patched, { baseVersion });
      this.noteWritten(path, patched, entry);
      return {
        file: await this.meta(path, patched, entry),
        historyId,
        content: patched,
      };
    });
  }

  /**
   * Converte atomicamente una pagina foglia `nome.md` in pagina-nodo `nome/_index.md`,
   * salvando uno snapshot e trasferendo l'intero storico delle versioni senza perdita di dati.
   */
  async convertLeafToNode(input: unknown): Promise<{
    from: string;
    to: string;
    historyId: string | null;
    file: FileMeta;
  }> {
    const leafPath = this.filePath(input);
    const lower = leafPath.toLowerCase();
    if (!lower.endsWith('.md') || lower === '_index.md' || lower.endsWith('/_index.md')) {
      throw badRequest('Solo una pagina foglia .md può essere convertita in pagina-nodo.');
    }
    const nodeDir = this.dirPath(leafPath.slice(0, -3));
    const indexPath = `${nodeDir}/_index.md`;

    return this.withLock(leafPath, async () => {
      if (await this.storage.stat(nodeDir)) {
        throw alreadyExists(`Esiste già una pagina-nodo "${nodeDir}".`);
      }
      const cur = await this.read(leafPath);
      const historyId = await this.history.save(leafPath, cur.content);
      const entry = await this.storage.create(indexPath, cur.content);
      await this.storage.delete(leafPath);
      await this.history.move(leafPath, indexPath);
      this.known.delete(leafPath);
      this.indexers.remove(leafPath);
      this.noteWritten(indexPath, cur.content, entry);
      await this.refresh();
      return {
        from: leafPath,
        to: indexPath,
        historyId,
        file: await this.meta(indexPath, cur.content, entry),
      };
    });
  }

  async create(input: unknown, contentIn: unknown = ''): Promise<WriteResult> {
    const path = this.filePath(input);
    const content = toLf(KbService.checkContent(contentIn));
    return this.withLock(path, async () => {
      // Collisione incrociata: se si crea `cartella/nome.md`, verifica che non esista già la pagina-nodo `cartella/nome`
      if (
        path.toLowerCase().endsWith('.md') &&
        path.toLowerCase() !== '_index.md' &&
        !path.toLowerCase().endsWith('/_index.md')
      ) {
        const stemDir = path.slice(0, -3);
        const dirStat = await this.storage.stat(stemDir);
        if (dirStat && dirStat.type === 'dir') {
          throw alreadyExists(`Esiste già una pagina con il nome "${stemDir}".`);
        }
      }
      const entry = await this.storage.create(path, content);
      this.noteWritten(path, content, entry);
      return { file: await this.meta(path, content, entry), historyId: null };
    });
  }

  async createDir(input: unknown): Promise<{ path: string }> {
    const path = this.dirPath(input);
    const leafCollision = await this.storage.stat(`${path}.md`);
    if (leafCollision) {
      throw alreadyExists(`Esiste già una pagina con il nome "${path}".`);
    }
    await this.storage.createDir(path);
    await this.refresh();
    return { path };
  }

  async rename(fromIn: unknown, toIn: unknown): Promise<MoveResult> {
    const rawFrom = this.anyPath(fromIn);
    if (rawFrom.toLowerCase() === '_index.md') {
      throw badRequest('La Home non può essere rinominata o spostata.');
    }

    // Se la richiesta punta a `<nodo>/_index.md`, rinominare la pagina-nodo significa rinominare la cartella `<nodo>`
    // (il nome del file `_index.md` al suo interno non cambia mai!)
    let effectiveFrom = rawFrom;
    let effectiveToInput: unknown = toIn;
    if (rawFrom.toLowerCase().endsWith('/_index.md')) {
      const candidateDir = rawFrom.slice(0, -'/_index.md'.length);
      const dirEntry = await this.storage.stat(candidateDir);
      if (dirEntry && dirEntry.type === 'dir') {
        effectiveFrom = candidateDir;
        if (typeof toIn === 'string') {
          const normTo = this.anyPath(toIn);
          if (normTo.toLowerCase().endsWith('/_index.md')) {
            effectiveToInput = normTo.slice(0, -'/_index.md'.length);
          } else if (normTo.toLowerCase().endsWith('.md')) {
            effectiveToInput = normTo.slice(0, -3);
          } else {
            effectiveToInput = normTo;
          }
        }
      }
    }

    const entry = await this.storage.stat(effectiveFrom);
    if (!entry) throw notFound(`"${effectiveFrom}" non esiste.`);
    const from = entry.type === 'file' ? this.filePath(effectiveFrom) : effectiveFrom;
    const to = entry.type === 'file' ? this.filePath(effectiveToInput) : this.dirPath(effectiveToInput);
    if (to.toLowerCase() === '_index.md') {
      throw alreadyExists('Il percorso della Home è riservato.');
    }
    if (from === to) return { from, to };
    if (entry.type === 'dir' && isUnder(to, from) && to.toLowerCase() !== from.toLowerCase()) {
      throw badRequest('Non puoi spostare una pagina dentro sé stessa.');
    }

    // Controllo collisioni tra pagina-foglia (`nome.md`) e pagina-nodo (`nome/`)
    const sameLogicalBase =
      (entry.type === 'file' && from.toLowerCase() === to.toLowerCase()) ||
      (entry.type === 'dir' && from.toLowerCase() === to.toLowerCase());

    if (!sameLogicalBase) {
      if (entry.type === 'file' && to.toLowerCase().endsWith('.md') && !to.toLowerCase().endsWith('/_index.md')) {
        const stemDir = to.slice(0, -3);
        if (await this.storage.stat(stemDir)) {
          throw alreadyExists(`Esiste già una pagina con questo nome ("${stemDir}").`);
        }
      } else if (entry.type === 'dir') {
        if (await this.storage.stat(`${to}.md`)) {
          throw alreadyExists(`Esiste già una pagina con questo nome ("${to}.md").`);
        }
      }
    }

    await this.withLock(from, () => this.storage.rename(from, to));
    await this.history.move(from, to);
    await this.refresh();
    return { from, to };
  }

  async archive(input: unknown): Promise<MoveResult> {
    const any = this.anyPath(input);
    if (any.toLowerCase() === '_index.md') {
      throw badRequest('La Home non può essere archiviata.');
    }
    const entry = await this.storage.stat(any);
    if (!entry) throw notFound(`"${any}" non esiste.`);
    const path = entry.type === 'file' ? this.filePath(any) : any;
    if (this.isArchived(path)) throw badRequest('Si trova già in archivio.');
    const dest = await this.withLock(path, () =>
      this.storage.archive(path, joinRel(ARCHIVE_DIR, localDate(this.now()))),
    );
    await this.history.move(path, dest);
    await this.refresh();
    return { from: path, to: dest };
  }

  async delete(input: unknown): Promise<{ path: string }> {
    const path = this.anyPath(input);
    if (path.toLowerCase() === '_index.md') {
      throw badRequest('La Home non può essere eliminata.');
    }
    const entry = await this.storage.stat(path);
    if (!entry) throw notFound(`"${path}" non esiste.`);
    await this.withLock(path, async () => {
      await this.storage.delete(path);
      await this.refresh();
    });
    return { path };
  }

  async search(q: unknown, opts: SearchOptions = {}): Promise<SearchResponse> {
    if (typeof q !== 'string' || q.trim() === '') throw badRequest('Testo di ricerca mancante.');
    if (q.length > MAX_QUERY_CHARS) throw badRequest('Testo di ricerca troppo lungo.');
    const needle = q.trim().toLowerCase();
    const limit = opts.limit ?? 200;
    const files = (await this.tree(!!opts.includeArchived)).filter(
      (e) => e.type === 'file' && (!opts.filter || opts.filter(e.path)),
    );
    const hits: SearchHit[] = [];
    let truncated = false;
    outer: for (const f of files) {
      const file = await this.storage.read(f.path).catch(() => null);
      if (!file) continue;
      const lines = file.content.split(/\r?\n/);
      let perFile = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const idx = line.toLowerCase().indexOf(needle);
        if (idx === -1) continue;
        if (hits.length >= limit) {
          truncated = true;
          break outer;
        }
        hits.push({ path: f.path, line: i + 1, column: idx + 1, preview: preview(line, idx), archived: f.archived });
        if (++perFile >= 20) break;
      }
    }
    return { hits, truncated };
  }

  async linksOf(input: unknown): Promise<LinksResponse> {
    const path = this.filePath(input);
    await this.refresh();
    const files = this.entries.filter((e) => e.type === 'file');
    return {
      path,
      outgoing: this.links.outgoing(path, files),
      backlinks: this.links.backlinks(path, files),
      tags: this.links.tagsOf(path),
    };
  }

  async tags(): Promise<TagInfo[]> {
    await this.refresh();
    return this.links.allTags();
  }

  historyList(input: unknown): Promise<HistoryEntry[]> {
    return this.history.list(this.filePath(input));
  }

  historyGet(input: unknown, id: unknown): Promise<string> {
    return this.history.get(this.filePath(input), assertHistoryId(id));
  }

  async restore(input: unknown, idIn: unknown): Promise<WriteResult> {
    const path = this.filePath(input);
    const id = assertHistoryId(idIn);
    const snapshot = await this.history.get(path, id);
    return this.withLock(path, async () => {
      if (await this.storage.stat(path)) {
        const cur = await this.read(path);
        if (cur.content === snapshot) return { file: toMeta(cur), historyId: null };
        const historyId = await this.history.save(path, cur.content);
        const entry = await this.storage.write(path, snapshot);
        this.noteWritten(path, snapshot, entry);
        return { file: await this.meta(path, snapshot, entry), historyId };
      }
      const entry = await this.storage.create(path, snapshot);
      this.noteWritten(path, snapshot, entry);
      return { file: await this.meta(path, snapshot, entry), historyId: null };
    });
  }
}

function toMeta(f: FileContent): FileMeta {
  return { path: f.path, version: f.version, eol: f.eol, size: f.size, mtimeMs: f.mtimeMs };
}

function preview(line: string, idx: number): string {
  const start = Math.max(0, idx - 60);
  const text = line.slice(start, start + 180).trim();
  return (start > 0 ? '…' : '') + text;
}
