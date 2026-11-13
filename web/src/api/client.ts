import type {
  AgentChatRequest,
  AgentEvent,
  AgentStatus,
  AlignIdsResponse,
  ApiErrorBody,
  AttachmentListResponse,
  AttachmentUploadResponse,
  ConfigResponse,
  ConvertLeafToNodeResponse,
  CreateDatabaseRequest,
  CreateDatabaseResponse,
  CreateDatabaseRowRequest,
  CreateDatabaseRowResponse,
  CreateSubpageResponse,
  DuplicateIdWarning,
  FileContent,
  FrontmatterPatchResponse,
  HistoryEntry,
  HistoryVersionResponse,
  LinksResponse,
  MoveResult,
  PageIdentity,
  SchemaOperationRequest,
  SchemaOperationResponse,
  SearchResponse,
  StatusResponse,
  TableQueryRequest,
  TableQueryResponse,
  TagInfo,
  TagsResponse,
  TreeEntry,
  TreeResponse,
  Vista,
  WriteResult,
} from '@brain/shared';
import { GithubClient } from './githubClient.js';

const TOKEN_KEY = 'brain_token';

export class ApiClient {
  private token: string | null = null;
  private readonly baseUrl: string;
  private readonly attachmentUrlCache = new Map<string, Promise<string | null>>();
  readonly github: GithubClient;

  constructor(baseUrl = 'http://127.0.0.1:4310') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = this.extractToken();
    this.github = new GithubClient();
  }

  /**
   * Determina se l'applicazione deve funzionare in modalità GitHub online
   * (su Cloudflare, GitHub Pages o host remoto) oppure in locale con Express backend.
   */
  isGithubMode(): boolean {
    if (typeof window === 'undefined') return false;

    // Possibilità di forzare la modalità via querystring (?backend=github oppure ?backend=local)
    try {
      const searchParams = new URLSearchParams(window.location.search);
      const queryBackend = searchParams.get('backend');
      if (queryBackend === 'github') return true;
      if (queryBackend === 'local') return false;
    } catch {
      // ignore
    }

    // Modalità impostata esplicitamente da build Vite
    if (import.meta.env?.VITE_BACKEND === 'github') {
      return true;
    }

    // Se l'host non è locale (127.0.0.1 o localhost), usa GitHub mode
    const host = window.location.hostname;
    return Boolean(host && host !== '127.0.0.1' && host !== 'localhost');
  }

  /**
   * Estrae il token dall'hash dell'URL (#token=...), lo memorizza in sessionStorage
   * e ripulisce subito la cronologia del browser con replaceState.
   */
  private extractToken(): string | null {
    if (typeof window === 'undefined') return null;

    try {
      const hash = window.location.hash;
      const match = hash.match(/token=([^&]+)/);
      if (match && match[1]) {
        const extracted = decodeURIComponent(match[1]);
        sessionStorage.setItem(TOKEN_KEY, extracted);
        // Rimuove il frammento con il token dall'URL senza ricaricare la pagina
        const cleanUrl = window.location.pathname + window.location.search;
        window.history.replaceState(null, '', cleanUrl);
        return extracted;
      }
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  getToken(): string | null {
    if (!this.token && typeof window !== 'undefined') {
      this.token = sessionStorage.getItem(TOKEN_KEY);
    }
    return this.token;
  }

  setToken(t: string): void {
    this.token = t;
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(TOKEN_KEY, t);
    }
  }

  hasToken(): boolean {
    if (this.isGithubMode()) {
      return this.github.hasToken();
    }
    return true; // Disattivato per ora in locale
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = this.getToken();
    const headers = new Headers(options.headers || {});
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      let errBody: ApiErrorBody | null = null;
      try {
        errBody = await res.json();
      } catch {
        // non JSON
      }

      const message = errBody?.error?.message || `Errore HTTP ${res.status}: ${res.statusText}`;
      const err = new Error(message) as Error & { code?: string; current?: FileContent; status: number };
      err.code = errBody?.error?.code;
      err.current = errBody?.error?.current;
      err.status = res.status;
      throw err;
    }

    if (res.status === 204) {
      return undefined as unknown as T;
    }

    return res.json() as Promise<T>;
  }

  getStatus(): Promise<StatusResponse> {
    if (this.isGithubMode()) {
      return this.github.getStatus();
    }
    return this.request<StatusResponse>('/v1/status');
  }

  getConfig(): Promise<ConfigResponse> {
    if (this.isGithubMode()) {
      return this.github.getConfigResponse();
    }
    return this.request<ConfigResponse>('/v1/config');
  }

  async getTree(all = false): Promise<TreeEntry[]> {
    if (this.isGithubMode()) {
      const res = await this.github.getTreeWithPages(all);
      return res.entries;
    }
    const res = await this.request<TreeResponse>(`/v1/tree${all ? '?all=true' : ''}`);
    return res.entries;
  }

  async getTreeWithPages(all = false): Promise<{
    entries: TreeEntry[];
    pages: PageIdentity[];
    duplicateIds: DuplicateIdWarning[];
  }> {
    if (this.isGithubMode()) {
      return this.github.getTreeWithPages(all);
    }
    const res = await this.request<TreeResponse>(`/v1/tree${all ? '?all=true' : ''}`);
    return {
      entries: res.entries,
      pages: res.pages ?? [],
      duplicateIds: res.duplicateIds ?? [],
    };
  }

  getFile(path: string): Promise<FileContent> {
    if (this.isGithubMode()) {
      return this.github.getFile(path);
    }
    return this.request<FileContent>(`/v1/files/content?path=${encodeURIComponent(path)}`);
  }

  saveFile(path: string, content: string, baseVersion: string): Promise<WriteResult> {
    if (this.isGithubMode()) {
      return this.github.saveFile(path, content, baseVersion);
    }
    return this.request<WriteResult>('/v1/files/content', {
      method: 'POST',
      body: JSON.stringify({ path, content, baseVersion }),
    });
  }

  patchFrontmatter(
    path: string,
    key: string,
    value: unknown,
    baseVersion: string,
    unset = false,
  ): Promise<FrontmatterPatchResponse> {
    if (this.isGithubMode()) {
      return this.github.patchFrontmatter(path, key, value, baseVersion, unset);
    }
    return this.request<FrontmatterPatchResponse>('/v1/files/frontmatter-patch', {
      method: 'POST',
      body: JSON.stringify({ path, key, value, baseVersion, unset }),
    });
  }

  createFile(path: string, content = ''): Promise<WriteResult> {
    if (this.isGithubMode()) {
      return this.github.createFile(path, content);
    }
    return this.request<WriteResult>('/v1/files/create', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    });
  }

  convertLeafToNode(path: string): Promise<ConvertLeafToNodeResponse> {
    if (this.isGithubMode()) {
      return this.github.convertLeafToNode(path);
    }
    return this.request<ConvertLeafToNodeResponse>('/v1/pages/convert-to-node', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  createSubpage(
    parentPath: string,
    title?: string,
    content?: string,
  ): Promise<CreateSubpageResponse> {
    if (this.isGithubMode()) {
      return this.github.createSubpage(parentPath, title, content);
    }
    return this.request<CreateSubpageResponse>('/v1/pages/create-subpage', {
      method: 'POST',
      body: JSON.stringify({ parentPath, title, content }),
    });
  }

  alignIds(dryRun = true): Promise<AlignIdsResponse> {
    if (this.isGithubMode()) {
      return Promise.resolve({
        dryRun,
        count: 0,
        paths: [],
        modified: [],
        duplicates: [],
      });
    }
    return this.request<AlignIdsResponse>('/v1/pages/align-ids', {
      method: 'POST',
      body: JSON.stringify({ dryRun }),
    });
  }

  createDatabase(req: CreateDatabaseRequest): Promise<CreateDatabaseResponse> {
    return this.request<CreateDatabaseResponse>('/v1/databases/create', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  getDatabase(dbId: string): Promise<TableQueryResponse> {
    return this.request<TableQueryResponse>(`/v1/databases/${encodeURIComponent(dbId)}`);
  }

  executeDatabaseSchemaOp(
    dbId: string,
    req: SchemaOperationRequest,
  ): Promise<SchemaOperationResponse> {
    return this.request<SchemaOperationResponse>(
      `/v1/databases/${encodeURIComponent(dbId)}/schema-op`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    );
  }

  createDatabaseRow(
    dbId: string,
    req: CreateDatabaseRowRequest = {},
  ): Promise<CreateDatabaseRowResponse> {
    return this.request<CreateDatabaseRowResponse>(
      `/v1/databases/${encodeURIComponent(dbId)}/rows`,
      {
        method: 'POST',
        body: JSON.stringify(req),
      },
    );
  }

  queryTableView(req: TableQueryRequest): Promise<TableQueryResponse> {
    return this.request<TableQueryResponse>('/v1/views/query', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async listAttachments(): Promise<string[]> {
    if (this.isGithubMode()) {
      const tree = await this.getTree();
      return tree
        .filter((e) => e.type === 'file' && e.path.startsWith('allegati/'))
        .map((e) => e.path.slice('allegati/'.length));
    }
    const res = await this.request<AttachmentListResponse>('/v1/attachments');
    return res.files;
  }

  uploadAttachment(filename: string, dataBase64: string): Promise<AttachmentUploadResponse> {
    if (this.isGithubMode()) {
      return this.github.uploadAttachment(filename, dataBase64);
    }
    return this.request<AttachmentUploadResponse>('/v1/attachments', {
      method: 'POST',
      body: JSON.stringify({ filename, dataBase64 }),
    });
  }

  getAttachmentObjectUrl(relPath: string): Promise<string | null> {
    const clean = relPath.trim();
    if (!clean) return Promise.resolve(null);
    const cached = this.attachmentUrlCache.get(clean);
    if (cached) return cached;

    if (this.isGithubMode()) {
      const p = this.github.getAttachmentObjectUrl(clean);
      this.attachmentUrlCache.set(clean, p);
      return p;
    }

    const promise = (async () => {
      try {
        const token = this.getToken();
        const headers = new Headers();
        if (token) headers.set('Authorization', `Bearer ${token}`);
        const res = await fetch(
          `${this.baseUrl}/v1/attachments/raw?path=${encodeURIComponent(clean)}`,
          { headers },
        );
        if (!res.ok) return null;
        const blob = await res.blob();
        return URL.createObjectURL(blob);
      } catch {
        return null;
      }
    })();

    this.attachmentUrlCache.set(clean, promise);
    return promise;
  }

  createFolder(path: string): Promise<{ success: boolean; path: string }> {
    if (this.isGithubMode()) {
      return Promise.resolve({ success: true, path });
    }
    return this.request<{ success: boolean; path: string }>('/v1/folders/create', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  rename(from: string, to: string): Promise<MoveResult> {
    if (this.isGithubMode()) {
      return this.github.rename(from, to);
    }
    return this.request<MoveResult>('/v1/files/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    });
  }

  archive(path: string): Promise<MoveResult> {
    if (this.isGithubMode()) {
      return this.github.archive(path);
    }
    return this.request<MoveResult>('/v1/files/archive', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }

  deleteFile(path: string): Promise<{ path: string }> {
    if (this.isGithubMode()) {
      return this.github.deleteFile(path);
    }
    return this.request<{ path: string }>(`/v1/files/${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
  }

  async getHistory(path: string): Promise<HistoryEntry[]> {
    if (this.isGithubMode()) {
      return this.github.getHistory(path);
    }
    const res = await this.request<{ path: string; entries: HistoryEntry[] }>(
      `/v1/files/history?path=${encodeURIComponent(path)}`,
    );
    return res.entries;
  }

  getHistoryVersion(path: string, id: string): Promise<HistoryVersionResponse> {
    if (this.isGithubMode()) {
      return this.github.getHistoryVersion(path, id);
    }
    return this.request<HistoryVersionResponse>(
      `/v1/files/history/version?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`,
    );
  }

  restoreHistory(path: string, id: string): Promise<WriteResult> {
    if (this.isGithubMode()) {
      return this.github.restoreHistory(path, id);
    }
    return this.request<WriteResult>('/v1/files/history/restore', {
      method: 'POST',
      body: JSON.stringify({ path, id }),
    });
  }

  search(q: string, limit = 100, includeArchived = false): Promise<SearchResponse> {
    if (this.isGithubMode()) {
      return this.github.search(q, limit);
    }
    const query = new URLSearchParams({
      q,
      limit: String(limit),
      includeArchived: String(includeArchived),
    });
    return this.request<SearchResponse>(`/v1/search?${query.toString()}`);
  }

  getLinks(path: string): Promise<LinksResponse> {
    if (this.isGithubMode()) {
      return this.github.getLinks(path);
    }
    return this.request<LinksResponse>(`/v1/links?path=${encodeURIComponent(path)}`);
  }

  async getTags(): Promise<TagInfo[]> {
    if (this.isGithubMode()) {
      return this.github.getTags();
    }
    const res = await this.request<TagsResponse>('/v1/tags');
    return res.tags;
  }

  getVista(): Promise<Vista> {
    if (this.isGithubMode()) {
      return this.github.getVista();
    }
    return this.request<Vista>('/v1/vista');
  }

  updateVista(patch: Partial<Vista>): Promise<Vista> {
    if (this.isGithubMode()) {
      return this.github.updateVista(patch);
    }
    return this.request<Vista>('/v1/vista', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  getAgentStatus(): Promise<AgentStatus> {
    if (this.isGithubMode()) {
      return Promise.resolve({
        configured: false,
        model: null,
        maxSteps: 0,
      });
    }
    return this.request<AgentStatus>('/v1/agent/status');
  }

  async getLinkMeta(url: string): Promise<{ title: string | null; favicon: string | null }> {
    if (this.isGithubMode()) {
      return { title: null, favicon: null };
    }
    try {
      return await this.request<{ title: string | null; favicon: string | null }>(
        `/v1/link-meta?url=${encodeURIComponent(url)}`,
      );
    } catch {
      return { title: null, favicon: null };
    }
  }

  async chatWithAgent(
    messages: AgentChatRequest['messages'],
    onEvent: (ev: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.isGithubMode()) {
      throw new Error('L\'assistente AI richiede l\'esecuzione locale dell\'app con backend Node.');
    }
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(`${this.baseUrl}/v1/agent/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages }),
      signal,
    });

    if (!res.ok) {
      let msg = `Errore di connessione con l'agente (${res.status})`;
      try {
        const json = await res.json();
        if (json.error?.message) msg = json.error.message;
      } catch {
        // non json
      }
      throw new Error(msg);
    }

    if (!res.body) {
      throw new Error('Nessun flusso di dati ricevuto dall\'agente.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          const lines = block.split('\n');
          let dataStr = '';

          for (const line of lines) {
            if (line.startsWith('data:')) {
              dataStr = line.slice(5).trim();
            }
          }

          if (dataStr) {
            try {
              const eventData = JSON.parse(dataStr) as AgentEvent;
              onEvent(eventData);
            } catch {
              // ignore malformed chunks
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export const api = new ApiClient();
