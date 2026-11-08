/**
 * Contratto tra API e interfaccia.
 * Questo file contiene SOLO tipi: nessuna logica, nessun valore a runtime.
 * Viene importato con `import type` sia da api/ sia da web/.
 */

// ---------------------------------------------------------------------------
// File e albero
// ---------------------------------------------------------------------------

/** Fine riga rilevato nel file. I file nuovi sono sempre LF. */
export type Eol = 'lf' | 'crlf';

export interface TreeEntry {
  /** Percorso relativo alla radice della KB, con "/" come separatore. */
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtimeMs: number;
  /** true se si trova dentro la cartella di archivio. */
  archived: boolean;
}

export interface DuplicateIdWarning {
  id: string;
  paths: string[];
}

export interface PageIdentity {
  /** Identificativo stabile e immutabile della pagina (non cambia se il file viene rinominato o spostato). */
  id: string;
  /** Percorso relativo attuale della nota nella KB (es. "nome.md" o "nome/_index.md"). */
  path: string;
  /** Eventuali percorsi precedenti prima di rinomine/spostamenti. */
  previousPaths?: string[];
  /** Emoji icona della pagina dal frontmatter ("icona:"). */
  icona?: string | null;
  /** Colore/gradiente o percorso allegato della copertina ("copertina:"). */
  copertina?: string | null;
  /** Tipo entità dal frontmatter (es. "database"). */
  tipo?: string | null;
  /** Id letto direttamente dal frontmatter ("id:"), se presente sul disco. */
  frontmatterId?: string | null;
  /** true se è una cartella esistente senza _index.md ancora materializzato su disco. */
  virtual?: boolean;
  /** Id dei database incorporati tramite ![[page:p_...]] nel corpo di questa pagina. */
  embeddedDatabaseIds?: string[];
}

export interface TreeResponse {
  entries: TreeEntry[];
  pages?: PageIdentity[];
  duplicateIds?: DuplicateIdWarning[];
}

export interface FileMeta {
  path: string;
  /** Hash SHA-256 (troncato) del contenuto: usato per il controllo di versione. */
  version: string;
  eol: Eol;
  size: number;
  mtimeMs: number;
  /** true se il file _index.md non esiste ancora su disco (cartella senza _index.md). */
  virtual?: boolean;
}

export interface FileContent extends FileMeta {
  content: string;
}

export interface WriteResult {
  file: FileMeta;
  /** Id dello snapshot della versione precedente salvato nello storico (null per i file nuovi). */
  historyId: string | null;
  /** Id stabile della pagina (presente alla creazione/scrittura). */
  pageId?: string;
  /** Contenuto effettivo scritto su disco (presente se sono stati rimossi link orfani o inserito l'id su nodo virtuale). */
  content?: string;
}

export interface MoveResult {
  from: string;
  to: string;
}

export interface ConvertLeafToNodeRequest {
  path: string;
}

export interface ConvertLeafToNodeResponse {
  from: string;
  to: string;
  pageId: string;
  historyId: string | null;
  file: FileMeta;
}

export interface CreateSubpageRequest {
  /** Percorso della pagina padre (es. "_index.md", "note/foglia.md" o "domini/corsa/_index.md"). */
  parentPath: string;
  /** Titolo opzionale per la sottopagina (predefinito "Nuova pagina"). */
  title?: string;
  /** Contenuto iniziale opzionale. */
  content?: string;
}

export interface CreateSubpageResponse {
  convertedParent?: {
    from: string;
    to: string;
    historyId: string | null;
  };
  created: WriteResult & { pageId: string };
}

export interface FrontmatterPatchRequest {
  path: string;
  baseVersion: string;
  key: string;
  value?: unknown;
  unset?: boolean;
}

export interface FrontmatterPatchResponse extends WriteResult {
  content: string;
}

export interface AttachmentUploadRequest {
  filename: string;
  dataBase64: string;
}

export interface AttachmentUploadResponse {
  path: string;
}

export interface AttachmentListResponse {
  files: string[];
}

// ---------------------------------------------------------------------------
// Proprietà tipizzate, Schema per tabella e Blocchi Vista
// ---------------------------------------------------------------------------

export type PropertyType =
  | 'testo'
  | 'numero'
  | 'seleziona'
  | 'selezione-multipla'
  | 'stato'
  | 'data'
  | 'casella'
  | 'url'
  | 'email'
  | 'telefono'
  | 'creato'
  | 'modificato';

export type PropertyColor =
  | 'grigio'
  | 'marrone'
  | 'arancione'
  | 'giallo'
  | 'verde'
  | 'blu'
  | 'viola'
  | 'rosa'
  | 'rosso';

export type StatusGroup = 'da-fare' | 'in-corso' | 'completato';

export interface PropertyOption {
  valore: string;
  colore: PropertyColor;
  /** Obbligatorio per le opzioni di tipo `stato`. */
  gruppo?: StatusGroup;
}

export interface PropertyDefinition {
  /** Slug stabile e immutabile usato come chiave nel frontmatter YAML. */
  chiave: string;
  /** Etichetta libera mostrata nell'interfaccia (max 60 caratteri). */
  nome: string;
  /** Tipo del controllo, del formato su file e della validazione. */
  tipo: PropertyType;
  /** Opzioni con colori per `seleziona`, `selezione-multipla` e `stato` (max 100). */
  opzioni?: PropertyOption[];
  /** Valore predefinito assegnato alla creazione di una nuova riga. */
  predefinito?: unknown;
  /** Numero di cifre decimali per il tipo `numero`. */
  decimali?: number;
}

export type FilterOperator =
  | 'uguale'
  | 'diverso'
  | 'contiene'
  | 'vuoto'
  | 'non-vuoto'
  | 'prima-di'
  | 'dopo-di'
  | 'maggiore'
  | 'minore'
  | 'include';

export interface VistaFilter {
  proprieta: string;
  operatore: FilterOperator;
  valore?: unknown;
}

export interface VistaSort {
  proprieta: string;
  direzione: 'asc' | 'desc';
}

export type VistaColumnSpec = string | { chiave: string; larghezza?: number };

export interface VistaBlockConfig {
  /** "database <id>" | "sottopagine" | "discendenti <id>" | "discendenti" | "tutte" */
  fonte: string;
  /** Chiavi delle colonne in ordine (il titolo è sempre la prima colonna). */
  colonne?: VistaColumnSpec[];
  /** Larghezze opzionali per chiave colonna (in pixel). */
  larghezze?: Record<string, number>;
  /** Criteri di ordinamento in cascata. */
  ordina?: VistaSort[];
  /** Filtri in AND. */
  filtri?: VistaFilter[];
  /** Definizioni locali delle sole colonne mostrate dal blocco vista (punto 1b). */
  proprieta?: PropertyDefinition[];
  /** Id di un database da cui riusare le definizioni dello schema (punto 1b). */
  schema?: string;
}

export interface ValueValidationResult {
  valid: boolean;
  empty: boolean;
  warning?: string;
  formatted?: string;
}

export interface UndefinedFieldInfo {
  chiave: string;
  count: number;
  sampleValues: unknown[];
  inferredType: PropertyType;
}

export interface EffectiveColumnMeta extends PropertyDefinition {
  computed?: boolean;
  width?: number;
  missingFromSchema?: boolean;
}

export interface TableRowItem {
  path: string;
  managePath: string;
  pageId: string;
  title: string;
  isNode: boolean;
  version: string;
  mtimeMs: number;
  creato: string | null;
  modificato: string;
  percorso: string;
  tag: string[];
  values: Record<string, unknown>;
  warnings: Record<string, string>;
}

export interface TableQueryRequest {
  hostPath?: string;
  vista: VistaBlockConfig;
}

export interface TableQueryResponse {
  sourceType: 'database' | 'sottopagine' | 'discendenti' | 'tutte';
  databaseId?: string | null;
  databasePath?: string | null;
  databaseVersion?: string | null;
  databaseName?: string | null;
  hostPath?: string;
  schema: PropertyDefinition[];
  effectiveColumns: EffectiveColumnMeta[];
  rows: TableRowItem[];
  totalRows: number;
  undefinedFields: UndefinedFieldInfo[];
  missingProperties: string[];
  canAddRow: boolean;
  canEditSchema: boolean;
  error?: string | null;
}

export interface CreateDatabaseRequest {
  hostPath: string;
  name?: string;
}

export interface CreateDatabaseResponse {
  convertedHost?: {
    from: string;
    to: string;
    historyId: string | null;
  };
  databaseId: string;
  databasePath: string;
  databaseName: string;
  vistaBlock: string;
}

export interface CreateDatabaseRowRequest {
  title?: string;
  initialValues?: Record<string, unknown>;
}

export interface CreateDatabaseRowResponse {
  created: WriteResult & { pageId: string; title: string };
}

export type SchemaOperationRequest =
  | {
      op: 'add-property';
      baseVersion?: string;
      nome: string;
      tipo: PropertyType;
      opzioni?: PropertyOption[];
      predefinito?: unknown;
      decimali?: number;
    }
  | {
      op: 'rename-property';
      baseVersion?: string;
      chiave: string;
      nuovoNome: string;
    }
  | {
      op: 'change-type';
      baseVersion?: string;
      chiave: string;
      nuovoTipo: PropertyType;
    }
  | {
      op: 'create-options-from-values';
      baseVersion?: string;
      chiave: string;
      targetTipo?: 'seleziona' | 'selezione-multipla' | 'stato';
      dryRun?: boolean;
    }
  | {
      op: 'update-options';
      baseVersion?: string;
      chiave: string;
      opzioni: PropertyOption[];
    }
  | {
      op: 'rename-option';
      baseVersion?: string;
      chiave: string;
      vecchioValore: string;
      nuovoValore: string;
      dryRun?: boolean;
    }
  | {
      op: 'set-default';
      baseVersion?: string;
      chiave: string;
      predefinito: unknown;
    }
  | {
      op: 'set-decimals';
      baseVersion?: string;
      chiave: string;
      decimali: number | undefined;
    }
  | {
      op: 'reorder-properties';
      baseVersion?: string;
      orderedKeys: string[];
    }
  | {
      op: 'delete-property';
      baseVersion?: string;
      chiave: string;
      dryRun?: boolean;
    }
  | {
      op: 'restore-undefined';
      baseVersion?: string;
      chiave: string;
      nome?: string;
      tipo: PropertyType;
      opzioni?: PropertyOption[];
    };

export interface SchemaOperationResponse {
  dryRun?: boolean;
  schema: PropertyDefinition[];
  databaseVersion?: string;
  historyId?: string | null;
  affectedCount?: number;
  affectedPaths?: string[];
  generatedOptions?: PropertyOption[];
  createdProperty?: PropertyDefinition;
}

export interface AlignIdsRequest {
  dryRun?: boolean;
}

export interface AlignIdsResponse {
  dryRun: boolean;
  count: number;
  paths: string[];
  modified: Array<{
    path: string;
    pageId: string;
    historyId: string | null;
  }>;
  duplicates: DuplicateIdWarning[];
}

// Corpi delle richieste
export interface WriteFileRequest {
  path: string;
  content: string;
  baseVersion: string;
}
export interface CreateFileRequest {
  path: string;
  content?: string;
}
export interface CreateDirRequest {
  path: string;
}
export interface RenameRequest {
  from: string;
  to: string;
}
export interface ArchiveRequest {
  path: string;
}
export interface RestoreRequest {
  path: string;
  id: string;
}

// ---------------------------------------------------------------------------
// Stato, configurazione, errori
// ---------------------------------------------------------------------------

export interface StatusResponse {
  /** Firma dell'albero (percorso + dimensione + data). Cambia se cambia qualcosa su disco. */
  signature: string;
  files: number;
}

export interface ConfigResponse {
  extensions: string[];
  archiveDir: string;
  agentDeny: string[];
}

export type ApiErrorCode =
  | 'bad_request'
  | 'invalid_path'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'already_exists'
  | 'unauthorized'
  | 'unsupported_media_type'
  | 'llm_not_configured'
  | 'internal';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Presente nei 409 di conflitto: la versione attuale su disco. */
    current?: FileContent;
  };
}

// ---------------------------------------------------------------------------
// Ricerca, link, tag
// ---------------------------------------------------------------------------

export interface SearchHit {
  path: string;
  /** Riga (1-based). */
  line: number;
  /** Colonna (1-based). */
  column: number;
  preview: string;
  archived: boolean;
}

export interface SearchResponse {
  hits: SearchHit[];
  truncated: boolean;
}

export type LinkStatus = 'ok' | 'broken' | 'archived';

export interface OutgoingLink {
  /** Testo originale, es. "[[cartella/nome|testo]]". */
  raw: string;
  target: string;
  alias: string | null;
  heading: string | null;
  /** Percorso risolto o null se il link è rotto. */
  path: string | null;
  status: LinkStatus;
  line: number;
}

export interface Backlink {
  path: string;
  line: number;
  context: string;
}

export interface LinksResponse {
  path: string;
  outgoing: OutgoingLink[];
  backlinks: Backlink[];
  tags: string[];
}

export interface TagInfo {
  tag: string;
  count: number;
  paths: string[];
}

export interface TagsResponse {
  tags: TagInfo[];
}

// ---------------------------------------------------------------------------
// Storico
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  size: number;
  /** ISO 8601. */
  createdAt: string;
}

export interface HistoryListResponse {
  path: string;
  entries: HistoryEntry[];
}

export interface HistoryVersionResponse {
  path: string;
  id: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Vista (preferenze dell'interfaccia, mai dentro la KB)
// ---------------------------------------------------------------------------

export type ViewMode = 'edit' | 'preview' | 'split';
export type ThemePref = 'auto' | 'light' | 'dark';

export interface Vista {
  theme: ThemePref;
  favorites: string[];
  collapsed: string[];
  showArchived: boolean;
  chatOpen: boolean;
  rightPanelOpen: boolean;
  viewMode: ViewMode;
  openTabs?: string[];
  activePath?: string | null;
}

// ---------------------------------------------------------------------------
// Agente
// ---------------------------------------------------------------------------

/** Messaggi inviati dal client: solo testo utente/assistente. Il server non conserva nulla. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentChatRequest {
  messages: ChatMessage[];
}

export interface AgentStatus {
  configured: boolean;
  model: string | null;
  maxSteps: number;
}

export type AgentToolAction =
  | 'list'
  | 'read'
  | 'search'
  | 'backlinks'
  | 'create'
  | 'modify'
  | 'append'
  | 'move'
  | 'archive';

/** Effetto di uno strumento, usato dall'interfaccia per link e pulsanti di annullamento. */
export interface AgentToolEffect {
  action: AgentToolAction;
  path?: string;
  from?: string;
  to?: string;
  historyId?: string | null;
}

export type AgentDoneReason = 'complete' | 'max_steps' | 'error' | 'aborted';

/** Eventi SSE di POST /v1/agent/chat (nome evento = type, data = JSON dell'evento). */
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      effect?: AgentToolEffect;
    }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done'; steps: number; reason: AgentDoneReason };
