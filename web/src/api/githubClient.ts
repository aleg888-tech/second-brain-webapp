import type {
  AttachmentUploadResponse,
  ConfigResponse,
  ConvertLeafToNodeResponse,
  CreateSubpageResponse,
  DuplicateIdWarning,
  FileContent,
  FrontmatterPatchResponse,
  HistoryEntry,
  HistoryVersionResponse,
  LinksResponse,
  MoveResult,
  PageIdentity,
  SearchHit,
  SearchResponse,
  StatusResponse,
  TagInfo,
  TreeEntry,
  Vista,
  WriteResult,
} from '@brain/shared';
import { parseFrontmatter, patchFrontmatterInMemory } from '../core/frontmatter.js';
import { isHomePage, isNodeIndexPath, sanitizeNoteTitleForFilename } from '../core/pages.js';

export interface GithubConfig {
  owner: string;
  repo: string;
  branch: string;
  percorsoKb: string;
  token: string;
}

const STORAGE_KEY_TOKEN = 'brain_gh_token';
const STORAGE_KEY_OWNER = 'brain_gh_owner';
const STORAGE_KEY_REPO = 'brain_gh_repo';
const STORAGE_KEY_BRANCH = 'brain_gh_branch';
const STORAGE_KEY_FOLDER = 'brain_gh_folder';
const STORAGE_KEY_VISTA = 'brain_vista_online';

const DEFAULT_OWNER = 'aleg888-tech';
const DEFAULT_REPO = 'second-brain';
const DEFAULT_BRANCH = 'main';
const DEFAULT_FOLDER = 'kb';

/**
 * Codifica una stringa UTF-8 in base64 compatibile con browser e caratteri speciali (emoji, accenti).
 */
export function encodeBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decodifica una stringa base64 in testo UTF-8 integro.
 */
export function decodeBase64Utf8(base64: string): string {
  const clean = base64.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Client browser puro che implementa il backend per GitHub REST API.
 * Consente di operare direttamente sul repository GitHub privato,
 * mantenendo il frontend completamente separato e le note private e sicure.
 */
export class GithubClient {
  private blobShas = new Map<string, string>();
  private fileContentCache = new Map<string, { content: string; version: string }>();
  private treeShaCache: string | null = null;
  private lastStatusFetchTime = 0;

  getConfig(): GithubConfig {
    if (typeof window === 'undefined') {
      return {
        owner: DEFAULT_OWNER,
        repo: DEFAULT_REPO,
        branch: DEFAULT_BRANCH,
        percorsoKb: DEFAULT_FOLDER,
        token: '',
      };
    }
    return {
      owner: localStorage.getItem(STORAGE_KEY_OWNER) || DEFAULT_OWNER,
      repo: localStorage.getItem(STORAGE_KEY_REPO) || DEFAULT_REPO,
      branch: localStorage.getItem(STORAGE_KEY_BRANCH) || DEFAULT_BRANCH,
      percorsoKb: localStorage.getItem(STORAGE_KEY_FOLDER) || DEFAULT_FOLDER,
      token: localStorage.getItem(STORAGE_KEY_TOKEN) || '',
    };
  }

  setConfig(patch: Partial<GithubConfig>): void {
    if (typeof window === 'undefined') return;
    if (patch.owner !== undefined) localStorage.setItem(STORAGE_KEY_OWNER, patch.owner.trim());
    if (patch.repo !== undefined) localStorage.setItem(STORAGE_KEY_REPO, patch.repo.trim());
    if (patch.branch !== undefined) localStorage.setItem(STORAGE_KEY_BRANCH, patch.branch.trim());
    if (patch.percorsoKb !== undefined) {
      localStorage.setItem(STORAGE_KEY_FOLDER, patch.percorsoKb.replace(/^\/+|\/+$/g, '').trim());
    }
    if (patch.token !== undefined) localStorage.setItem(STORAGE_KEY_TOKEN, patch.token.trim());
  }

  clearConfig(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_OWNER);
    localStorage.removeItem(STORAGE_KEY_REPO);
    localStorage.removeItem(STORAGE_KEY_BRANCH);
    localStorage.removeItem(STORAGE_KEY_FOLDER);
    this.blobShas.clear();
    this.fileContentCache.clear();
    this.treeShaCache = null;
  }

  hasToken(): boolean {
    const cfg = this.getConfig();
    return Boolean(cfg.token && cfg.token.length > 5);
  }

  /**
   * Normalizza e valida i percorsi delle note per impedire accessi esterni a kb/.
   */
  validatePath(rawPath: string): string {
    if (!rawPath || typeof rawPath !== 'string') {
      throw new Error('Percorso non valido.');
    }
    const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    const segments = normalized.split('/');
    if (segments.some((s) => s === '..' || s === '.')) {
      throw new Error(`Path traversal vietato: "${rawPath}".`);
    }
    const protectedDirs = ['webapp', '.github', 'node_modules', '.brain'];
    if (protectedDirs.includes(segments[0].toLowerCase())) {
      throw new Error(`Accesso vietato alla cartella di sistema: "${segments[0]}".`);
    }
    return normalized;
  }

  private getFullKbPath(relPath: string): string {
    const valid = this.validatePath(relPath);
    const cfg = this.getConfig();
    const kb = cfg.percorsoKb || DEFAULT_FOLDER;
    return `${kb}/${valid}`;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const cfg = this.getConfig();
    if (!cfg.token) {
      const err = new Error(
        'Token GitHub non configurato. Effettua prima l\'accesso con il tuo Personal Access Token.',
      ) as any;
      err.status = 401;
      throw err;
    }

    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${cfg.token}`);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('X-GitHub-Api-Version', '2022-11-28');
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const url = endpoint.startsWith('https://')
      ? endpoint
      : `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${endpoint}`;

    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (!res.ok) {
      let msg = `Errore GitHub API HTTP ${res.status}: ${res.statusText}`;
      let errBody: any = null;
      try {
        errBody = await res.json();
        if (errBody?.message) {
          msg = errBody.message;
        }
      } catch {
        // non json
      }

      const err = new Error(msg) as any;
      err.status = res.status;
      err.code = res.status === 409 ? 'CONFLICT' : res.status === 404 ? 'NOT_FOUND' : 'GITHUB_ERROR';
      throw err;
    }

    if (res.status === 204) {
      return undefined as unknown as T;
    }

    return res.json() as Promise<T>;
  }

  /**
   * Verifica la connessione al repository GitHub controllando i permessi del token.
   */
  async validateConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const cfg = this.getConfig();
      if (!cfg.token) {
        return { success: false, error: 'Token non inserito.' };
      }
      await this.request<{ name: string }>('');
      return { success: true };
    } catch (err: any) {
      if (err.status === 401) {
        return { success: false, error: 'Token non valido o scaduto (HTTP 401).' };
      }
      if (err.status === 404) {
        return {
          success: false,
          error: 'Repository non trovato o token privo dei permessi sul repository privato (HTTP 404).',
        };
      }
      return { success: false, error: err.message || 'Errore durante la connessione a GitHub.' };
    }
  }

  async getStatus(): Promise<StatusResponse> {
    const now = Date.now();
    // Cache per non consumare il rate limit di GitHub
    if (this.treeShaCache && now - this.lastStatusFetchTime < 30000) {
      return {
        signature: this.treeShaCache,
        files: this.blobShas.size,
      };
    }

    try {
      const cfg = this.getConfig();
      const res = await this.request<{ commit: { sha: string } }>(
        `/branches/${encodeURIComponent(cfg.branch)}`,
      );
      this.treeShaCache = res.commit.sha;
      this.lastStatusFetchTime = now;
      return {
        signature: res.commit.sha,
        files: this.blobShas.size,
      };
    } catch {
      return {
        signature: this.treeShaCache || 'offline',
        files: this.blobShas.size,
      };
    }
  }

  async getConfigResponse(): Promise<ConfigResponse> {
    return {
      extensions: ['.md', '.csv', '.txt'],
      archiveDir: '_archivio',
      agentDeny: [],
    };
  }

  /**
   * Recupera l'intero albero della Knowledge Base con una sola chiamata alle Git Trees API.
   */
  async getTreeWithPages(_all = false): Promise<{
    entries: TreeEntry[];
    pages: PageIdentity[];
    duplicateIds: DuplicateIdWarning[];
  }> {
    const cfg = this.getConfig();
    const kb = cfg.percorsoKb || DEFAULT_FOLDER;
    const kbPrefix = `${kb}/`;

    const treeData = await this.request<{
      sha: string;
      tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>;
    }>(`/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`);

    this.treeShaCache = treeData.sha;
    this.lastStatusFetchTime = Date.now();

    const entries: TreeEntry[] = [];
    const pages: PageIdentity[] = [];

    for (const item of treeData.tree) {
      if (!item.path.startsWith(kbPrefix) && item.path !== kb) {
        continue;
      }

      const relPath = item.path === kb ? '' : item.path.slice(kbPrefix.length);
      if (!relPath) continue;

      const isArchived = relPath.startsWith('_archivio/') || relPath.startsWith('archivio/');

      if (item.type === 'blob') {
        this.blobShas.set(relPath, item.sha);
        entries.push({
          path: relPath,
          type: 'file',
          size: item.size ?? 0,
          mtimeMs: Date.now(),
          archived: isArchived,
        });

        if (relPath.toLowerCase().endsWith('.md')) {
          pages.push({
            id: relPath,
            path: relPath,
            icona: null,
            copertina: null,
            tipo: null,
          });
        }
      } else if (item.type === 'tree') {
        entries.push({
          path: relPath,
          type: 'dir',
          size: 0,
          mtimeMs: Date.now(),
          archived: isArchived,
        });
      }
    }

    return {
      entries,
      pages,
      duplicateIds: [],
    };
  }

  /**
   * Legge il contenuto di un file dalla KB via GitHub Contents API.
   */
  async getFile(path: string): Promise<FileContent> {
    const valid = this.validatePath(path);
    const fullPath = this.getFullKbPath(valid);
    const cfg = this.getConfig();

    const data = await this.request<{
      name: string;
      path: string;
      sha: string;
      size: number;
      encoding?: string;
      content?: string;
    }>(`/contents/${encodeURIComponent(fullPath)}?ref=${encodeURIComponent(cfg.branch)}`);

    if (!data.content) {
      throw new Error(`File vuoto o contenuto non disponibile per "${path}".`);
    }

    const content = decodeBase64Utf8(data.content);
    this.blobShas.set(valid, data.sha);
    this.fileContentCache.set(valid, { content, version: data.sha });

    return {
      path: valid,
      content,
      version: data.sha,
      eol: content.includes('\r\n') ? 'crlf' : 'lf',
      size: data.size,
      mtimeMs: Date.now(),
      virtual: false,
    };
  }

  /**
   * Salva o modifica un file nella KB creando un commit su GitHub con optimistic locking.
   */
  async saveFile(path: string, content: string, baseVersion: string): Promise<WriteResult> {
    const valid = this.validatePath(path);
    const fullPath = this.getFullKbPath(valid);
    const cfg = this.getConfig();

    const sha = baseVersion || this.blobShas.get(valid);

    const body: Record<string, unknown> = {
      message: `kb: aggiorna ${valid}`,
      content: encodeBase64Utf8(content),
      branch: cfg.branch,
    };
    if (sha) {
      body.sha = sha;
    }

    const res = await this.request<{
      content: { name: string; path: string; sha: string; size: number };
      commit: { sha: string };
    }>(`/contents/${encodeURIComponent(fullPath)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    const newSha = res.content.sha;
    this.blobShas.set(valid, newSha);
    this.fileContentCache.set(valid, { content, version: newSha });

    return {
      file: {
        path: valid,
        version: newSha,
        eol: content.includes('\r\n') ? 'crlf' : 'lf',
        size: res.content.size,
        mtimeMs: Date.now(),
      },
      historyId: res.commit.sha,
      content,
    };
  }

  /**
   * Crea un nuovo file nella KB.
   */
  async createFile(path: string, content = ''): Promise<WriteResult> {
    const valid = this.validatePath(path);
    const fullPath = this.getFullKbPath(valid);
    const cfg = this.getConfig();

    const body = {
      message: `kb: crea ${valid}`,
      content: encodeBase64Utf8(content),
      branch: cfg.branch,
    };

    const res = await this.request<{
      content: { name: string; path: string; sha: string; size: number };
      commit: { sha: string };
    }>(`/contents/${encodeURIComponent(fullPath)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    const newSha = res.content.sha;
    this.blobShas.set(valid, newSha);
    this.fileContentCache.set(valid, { content, version: newSha });

    return {
      file: {
        path: valid,
        version: newSha,
        eol: 'lf',
        size: res.content.size,
        mtimeMs: Date.now(),
      },
      historyId: res.commit.sha,
      content,
    };
  }

  /**
   * Aggiorna selettivamente una chiave di frontmatter in memoria e la invia a GitHub.
   */
  async patchFrontmatter(
    path: string,
    key: string,
    value: unknown,
    baseVersion: string,
    unset = false,
  ): Promise<FrontmatterPatchResponse> {
    const valid = this.validatePath(path);
    const file = await this.getFile(valid);
    const updatedContent = patchFrontmatterInMemory(file.content, key, value, unset);
    const writeResult = await this.saveFile(valid, updatedContent, baseVersion || file.version);

    return {
      file: writeResult.file,
      historyId: writeResult.historyId,
      content: updatedContent,
      pageId: valid,
    };
  }

  /**
   * Crea una sotto-pagina rispettando la gerarchia della KB.
   */
  async createSubpage(
    parentPath: string,
    title?: string,
    content = '',
  ): Promise<CreateSubpageResponse> {
    const cleanParent = this.validatePath(parentPath);
    const pageTitle = (title || 'Nuova pagina').trim();
    const slug = sanitizeNoteTitleForFilename(pageTitle) || 'nuova-nota';

    let targetPath: string;
    let convertedParent: { from: string; to: string; historyId: string | null } | undefined;

    if (isHomePage(cleanParent)) {
      targetPath = `${slug}.md`;
    } else if (isNodeIndexPath(cleanParent)) {
      const parentDir = cleanParent.slice(0, -'/_index.md'.length);
      targetPath = `${parentDir}/${slug}.md`;
    } else {
      if (cleanParent.toLowerCase().endsWith('.md')) {
        const conv = await this.convertLeafToNode(cleanParent);
        convertedParent = { from: conv.from, to: conv.to, historyId: conv.historyId };
        const nodeDir = cleanParent.slice(0, -3);
        targetPath = `${nodeDir}/${slug}.md`;
      } else {
        targetPath = `${cleanParent}/${slug}.md`;
      }
    }

    const initialContent = `---
titolo: ${pageTitle}
---

${content}`.trim() + '\n';

    const writeRes = await this.createFile(targetPath, initialContent);
    return {
      created: {
        ...writeRes,
        pageId: targetPath,
      },
      convertedParent,
    };
  }

  /**
   * Converte una nota foglia 'cartella/nota.md' in una cartella nodo 'cartella/nota/_index.md'.
   */
  async convertLeafToNode(path: string): Promise<ConvertLeafToNodeResponse> {
    const valid = this.validatePath(path);
    if (!valid.toLowerCase().endsWith('.md') || isNodeIndexPath(valid) || isHomePage(valid)) {
      throw new Error(`Impossibile convertire "${path}" in pagina nodo.`);
    }

    const currentFile = await this.getFile(valid);
    const nodeDirPath = valid.slice(0, -3);
    const targetIndexPath = `${nodeDirPath}/_index.md`;

    const writeRes = await this.createFile(targetIndexPath, currentFile.content);
    await this.deleteFile(valid);

    return {
      from: valid,
      to: targetIndexPath,
      pageId: targetIndexPath,
      historyId: writeRes.historyId,
      file: writeRes.file,
    };
  }

  /**
   * Elimina un file dalla KB su GitHub.
   */
  async deleteFile(path: string): Promise<{ path: string }> {
    const valid = this.validatePath(path);
    const fullPath = this.getFullKbPath(valid);
    const cfg = this.getConfig();

    let sha = this.blobShas.get(valid);
    if (!sha) {
      try {
        const check = await this.request<{ sha: string }>(
          `/contents/${encodeURIComponent(fullPath)}?ref=${encodeURIComponent(cfg.branch)}`,
        );
        sha = check.sha;
      } catch {
        return { path: valid };
      }
    }

    await this.request<{ commit: { sha: string } }>(
      `/contents/${encodeURIComponent(fullPath)}`,
      {
        method: 'DELETE',
        body: JSON.stringify({
          message: `kb: elimina ${valid}`,
          sha,
          branch: cfg.branch,
        }),
      },
    );

    this.blobShas.delete(valid);
    this.fileContentCache.delete(valid);
    return { path: valid };
  }

  async rename(from: string, to: string): Promise<MoveResult> {
    const validFrom = this.validatePath(from);
    const validTo = this.validatePath(to);

    const source = await this.getFile(validFrom);
    await this.createFile(validTo, source.content);
    await this.deleteFile(validFrom);

    return { from: validFrom, to: validTo };
  }

  async archive(path: string): Promise<MoveResult> {
    const valid = this.validatePath(path);
    const target = `_archivio/${valid}`;
    return this.rename(valid, target);
  }

  async getHistory(path: string): Promise<HistoryEntry[]> {
    const valid = this.validatePath(path);
    const fullPath = this.getFullKbPath(valid);
    const cfg = this.getConfig();

    const commits = await this.request<
      Array<{ sha: string; commit: { author: { date: string }; message: string } }>
    >(`/commits?path=${encodeURIComponent(fullPath)}&sha=${encodeURIComponent(cfg.branch)}`);

    return (commits || []).map((c) => ({
      id: c.sha,
      size: 0,
      createdAt: c.commit.author.date,
    }));
  }

  async getHistoryVersion(path: string, id: string): Promise<HistoryVersionResponse> {
    const valid = this.validatePath(path);
    const fullPath = this.getFullKbPath(valid);

    const data = await this.request<{
      content?: string;
      size: number;
    }>(`/contents/${encodeURIComponent(fullPath)}?ref=${encodeURIComponent(id)}`);

    const content = data.content ? decodeBase64Utf8(data.content) : '';

    return {
      path: valid,
      id,
      content,
    };
  }

  async restoreHistory(path: string, id: string): Promise<WriteResult> {
    const historic = await this.getHistoryVersion(path, id);
    const current = await this.getFile(path);
    return this.saveFile(path, historic.content, current.version);
  }

  async getVista(): Promise<Vista> {
    const defaults: Vista = {
      theme: 'dark',
      favorites: ['_index.md'],
      collapsed: [],
      showArchived: false,
      chatOpen: false,
      rightPanelOpen: true,
      viewMode: 'split',
      openTabs: ['_index.md'],
      activePath: '_index.md',
    };

    if (typeof window === 'undefined') return defaults;
    try {
      const stored = localStorage.getItem(STORAGE_KEY_VISTA);
      if (!stored) return defaults;
      return { ...defaults, ...JSON.parse(stored) };
    } catch {
      return defaults;
    }
  }

  async updateVista(patch: Partial<Vista>): Promise<Vista> {
    const current = await this.getVista();
    const updated = { ...current, ...patch };
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY_VISTA, JSON.stringify(updated));
      } catch {
        // ignore storage quota errors
      }
    }
    return updated;
  }

  async getTags(): Promise<TagInfo[]> {
    const tagMap = new Map<string, string[]>();
    for (const [path, cached] of this.fileContentCache.entries()) {
      if (!path.toLowerCase().endsWith('.md')) continue;
      const parsed = parseFrontmatter(cached.content);
      const tags = parsed.frontmatter?.tag;
      if (Array.isArray(tags)) {
        for (const t of tags) {
          if (typeof t === 'string' && t.trim()) {
            const cleanTag = t.trim();
            const list = tagMap.get(cleanTag) ?? [];
            if (!list.includes(path)) {
              list.push(path);
              tagMap.set(cleanTag, list);
            }
          }
        }
      }
    }
    return Array.from(tagMap.entries()).map(([tag, paths]) => ({
      tag,
      count: paths.length,
      paths,
    }));
  }

  async search(query: string, limit = 50): Promise<SearchResponse> {
    const q = query.trim().toLowerCase();
    const hits: SearchHit[] = [];

    for (const [path, cached] of this.fileContentCache.entries()) {
      if (hits.length >= limit) break;
      const lines = cached.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i]!;
        const col = lineText.toLowerCase().indexOf(q);
        if (col !== -1) {
          hits.push({
            path,
            line: i + 1,
            column: col + 1,
            preview: lineText.trim(),
            archived: path.startsWith('_archivio/') || path.startsWith('archivio/'),
          });
          if (hits.length >= limit) break;
        }
      }
    }

    return { hits, truncated: hits.length >= limit };
  }

  async getLinks(path: string): Promise<LinksResponse> {
    return {
      path,
      outgoing: [],
      backlinks: [],
      tags: [],
    };
  }

  async getAttachmentObjectUrl(relPath: string): Promise<string | null> {
    try {
      const valid = this.validatePath(relPath);
      const fullPath = this.getFullKbPath(valid);
      const cfg = this.getConfig();

      const data = await this.request<{ content?: string }>(
        `/contents/${encodeURIComponent(fullPath)}?ref=${encodeURIComponent(cfg.branch)}`,
      );
      if (!data.content) return null;

      const binaryStr = atob(data.content.replace(/\s+/g, ''));
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const mime = valid.endsWith('.png')
        ? 'image/png'
        : valid.endsWith('.jpg') || valid.endsWith('.jpeg')
          ? 'image/jpeg'
          : valid.endsWith('.svg')
            ? 'image/svg+xml'
            : 'application/octet-stream';

      const blob = new Blob([bytes], { type: mime });
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  async uploadAttachment(filename: string, dataBase64: string): Promise<AttachmentUploadResponse> {
    const cleanFilename = sanitizeNoteTitleForFilename(filename) || 'allegato.png';
    const targetPath = `allegati/${cleanFilename}`;
    const base64Data = dataBase64.includes(',') ? dataBase64.split(',')[1] : dataBase64;

    const fullPath = this.getFullKbPath(targetPath);
    const cfg = this.getConfig();

    await this.request<{ content: { sha: string } }>(`/contents/${encodeURIComponent(fullPath)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `kb: carica allegato ${cleanFilename}`,
        content: base64Data,
        branch: cfg.branch,
      }),
    });

    return {
      path: targetPath,
    };
  }
}
