import type { PageIdentity, TreeEntry } from '@brain/shared';

export interface ResolvedPageTarget {
  id: string | null;
  path: string;
  displayTitle: string;
  icona?: string | null;
}

export interface UnifiedPageNode {
  key: string;
  /** Nome visibile nella sidebar (mai `_index.md` né `.md` per le note). */
  name: string;
  /** Percorso da aprire nell'editor (es. `_index.md`, `note/foglia.md`, `domini/corsa/_index.md`). */
  openPath: string;
  /** Percorso cartella se pagina-nodo (`domini/corsa`), altrimenti `null`. */
  dirPath: string | null;
  /** Percorso da usare per rinomina/archiviazione/eliminazione (`dirPath` per nodi, `openPath` per foglie). */
  managePath: string;
  isHome: boolean;
  /** `true` se è una cartella esistente senza `_index.md` ancora creato su disco. */
  isVirtualIndex: boolean;
  isMarkdownPage: boolean;
  archived: boolean;
  pageId: string | null;
  icona: string | null;
  copertina: string | null;
  tipo: string | null;
  children: UnifiedPageNode[];
}

export interface BuildPageTreeOptions {
  showArchived?: boolean;
  filterQuery?: string;
  hideEmbeddedDatabases?: boolean;
  liveTitleDrafts?: Readonly<Record<string, string>>;
}

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const ATTACHMENTS_PREFIX = 'allegati';

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function stripMdExt(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p;
}

export function isAttachmentPath(p: string): boolean {
  const lower = p.toLowerCase();
  return lower === ATTACHMENTS_PREFIX || lower.startsWith(`${ATTACHMENTS_PREFIX}/`);
}

export function isHomePage(path: string | null | undefined): boolean {
  if (!path) return false;
  return path.trim().toLowerCase() === '_index.md';
}

export function isNodeIndexPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return path.trim().toLowerCase().endsWith('/_index.md');
}

export function nodeDirOfPagePath(path: string): string | null {
  if (isHomePage(path)) return '';
  if (isNodeIndexPath(path)) {
    return path.slice(0, -'/_index.md'.length);
  }
  return null;
}

/**
 * Restituisce il nome visibile della pagina (identico tra titolo pinnato in alto, sidebar e anteprima link).
 * `_index.md` alla radice è sempre "Home"; `<nodo>/_index.md` mostra sempre il nome del nodo (`<nodo>`).
 */
export function getNoteDisplayName(
  path: string,
  liveTitleDrafts?: Readonly<Record<string, string>>,
): string {
  if (isHomePage(path)) {
    return 'Home';
  }
  if (liveTitleDrafts) {
    if (Object.prototype.hasOwnProperty.call(liveTitleDrafts, path)) {
      const draft = liveTitleDrafts[path]!;
      return draft.trim().length > 0 ? draft : 'Senza titolo';
    }
    const dir = nodeDirOfPagePath(path);
    if (dir && Object.prototype.hasOwnProperty.call(liveTitleDrafts, dir)) {
      const draft = liveTitleDrafts[dir]!;
      return draft.trim().length > 0 ? draft : 'Senza titolo';
    }
  }
  if (isNodeIndexPath(path)) {
    const folder = path.slice(0, -'/_index.md'.length);
    return baseName(folder);
  }
  const base = baseName(path);
  if (base.toLowerCase().endsWith('.md')) {
    return base.slice(0, -3);
  }
  return base;
}

/**
 * Pulisce un titolo digitato dall'utente affinché sia un nome file/cartella valido su Windows e nella KB.
 */
export function sanitizeNoteTitleForFilename(rawTitle: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = rawTitle
    .replace(/[<>:"/\\|?*%\u0000-\u001f]/g, '')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  if (!cleaned) return '';
  const stem = cleaned.split('.')[0] ?? cleaned;
  if (RESERVED_WINDOWS.test(stem)) return '';
  if (cleaned.toLowerCase() === '_index' || cleaned.toLowerCase() === '_index.md') return '';
  return cleaned;
}

/**
 * Costruisce l'albero unico di pagine per la sidebar:
 * - Home (`_index.md`) fissata in cima con nome fisso "Home".
 * - Nessuna distinzione cartella/file: `nome/` + `nome/_index.md` formano un'unica pagina-nodo;
 *   `_index.md` non è mai visibile come elemento figlio.
 * - Cartelle esistenti prive di `_index.md` appaiono come pagine con `isVirtualIndex: true`.
 */
export function buildUnifiedPageTree(
  entries: readonly TreeEntry[],
  pages: readonly PageIdentity[] = [],
  options: BuildPageTreeOptions = {},
): UnifiedPageNode[] {
  const {
    showArchived = false,
    filterQuery = '',
    hideEmbeddedDatabases = false,
    liveTitleDrafts,
  } = options;

  const pageByLower = new Map<string, PageIdentity>();
  const embeddedDbIds = new Set<string>();
  for (const p of pages) {
    pageByLower.set(p.path.toLowerCase(), p);
    if (p.embeddedDatabaseIds) {
      for (const dbId of p.embeddedDatabaseIds) {
        embeddedDbIds.add(dbId);
      }
    }
  }

  const visibleEntries = entries.filter((e) => {
    if (!showArchived && e.archived) return false;
    if (isAttachmentPath(e.path)) return false;
    return true;
  });

  interface BuilderDir {
    dirPath: string;
    name: string;
    archived: boolean;
    indexFilePath: string | null;
    subDirs: Map<string, BuilderDir>;
    leafFiles: TreeEntry[];
  }

  const root: BuilderDir = {
    dirPath: '',
    name: '',
    archived: false,
    indexFilePath: null,
    subDirs: new Map(),
    leafFiles: [],
  };

  const ensureDirChain = (dirPath: string, archived: boolean): BuilderDir => {
    const parts = dirPath.split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const lower = part.toLowerCase();
      let child = cur.subDirs.get(lower);
      if (!child) {
        const curSubPath = parts.slice(0, i + 1).join('/');
        child = {
          dirPath: curSubPath,
          name: part,
          archived,
          indexFilePath: null,
          subDirs: new Map(),
          leafFiles: [],
        };
        cur.subDirs.set(lower, child);
      } else {
        // Aggiorna capitalizzazione al nome reale della cartella
        child.dirPath = parts.slice(0, i + 1).join('/');
        child.name = part;
      }
      cur = child;
    }
    return cur;
  };

  for (const e of visibleEntries) {
    if (e.type === 'dir') {
      ensureDirChain(e.path, e.archived);
    }
  }

  for (const e of visibleEntries) {
    if (e.type !== 'file') continue;
    if (e.path.toLowerCase() === '_index.md') {
      root.indexFilePath = e.path;
      continue;
    }
    const parentPath = dirName(e.path);
    const fileName = baseName(e.path);
    const parentDir = parentPath ? ensureDirChain(parentPath, e.archived) : root;

    if (fileName.toLowerCase() === '_index.md' && parentPath !== '') {
      parentDir.indexFilePath = e.path;
    } else {
      parentDir.leafFiles.push(e);
    }
  }

  const query = filterQuery.trim().toLowerCase();

  const buildFromDir = (dir: BuilderDir): UnifiedPageNode[] => {
    const nodes: UnifiedPageNode[] = [];

    // 1. Sotto-pagine nodo (cartelle con o senza _index.md)
    for (const sub of dir.subDirs.values()) {
      const openPath = sub.indexFilePath ?? `${sub.dirPath}/_index.md`;
      const meta = pageByLower.get(openPath.toLowerCase());
      if (
        hideEmbeddedDatabases &&
        meta?.tipo === 'database' &&
        meta.id &&
        embeddedDbIds.has(meta.id)
      ) {
        continue;
      }

      const builtChildren = buildFromDir(sub);
      const displayName = getNoteDisplayName(openPath, liveTitleDrafts);
      const selfMatches =
        !query ||
        displayName.toLowerCase().includes(query) ||
        sub.dirPath.toLowerCase().includes(query);

      if (query && !selfMatches && builtChildren.length === 0) {
        continue;
      }

      nodes.push({
        key: `node:${sub.dirPath}`,
        name: displayName,
        openPath,
        dirPath: sub.dirPath,
        managePath: sub.dirPath,
        isHome: false,
        isVirtualIndex: sub.indexFilePath === null,
        isMarkdownPage: true,
        archived: sub.archived,
        pageId: meta?.id ?? null,
        icona: meta?.icona ?? null,
        copertina: meta?.copertina ?? null,
        tipo: meta?.tipo ?? null,
        children: builtChildren,
      });
    }

    // 2. Pagine foglia (.md) e altri file ammessi (.csv, .txt)
    for (const f of dir.leafFiles) {
      const meta = pageByLower.get(f.path.toLowerCase());
      const displayName = getNoteDisplayName(f.path, liveTitleDrafts);
      const selfMatches =
        !query ||
        displayName.toLowerCase().includes(query) ||
        f.path.toLowerCase().includes(query);
      if (!selfMatches) continue;

      nodes.push({
        key: `leaf:${f.path}`,
        name: displayName,
        openPath: f.path,
        dirPath: null,
        managePath: f.path,
        isHome: false,
        isVirtualIndex: false,
        isMarkdownPage: f.path.toLowerCase().endsWith('.md'),
        archived: f.archived,
        pageId: meta?.id ?? null,
        icona: meta?.icona ?? null,
        copertina: meta?.copertina ?? null,
        tipo: meta?.tipo ?? null,
        children: [],
      });
    }

    nodes.sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
    return nodes;
  };

  const result: UnifiedPageNode[] = [];

  if (root.indexFilePath) {
    const homeMeta = pageByLower.get(root.indexFilePath.toLowerCase());
    const homeMatches = !query || 'home'.includes(query) || '_index.md'.includes(query);
    if (homeMatches) {
      result.push({
        key: 'home:_index.md',
        name: 'Home',
        openPath: root.indexFilePath,
        dirPath: null,
        managePath: root.indexFilePath,
        isHome: true,
        isVirtualIndex: false,
        isMarkdownPage: true,
        archived: false,
        pageId: homeMeta?.id ?? null,
        icona: homeMeta?.icona ?? null,
        copertina: homeMeta?.copertina ?? null,
        tipo: homeMeta?.tipo ?? null,
        children: [],
      });
    }
  }

  result.push(...buildFromDir(root));
  return result;
}

/**
 * Risolve il target di un link interno (sia `page:<id>` sia percorso/nome legacy)
 * verso una pagina realmente esistente nella KB (foglia, nodo o cartella virtuale).
 * Restituisce `null` se la pagina non esiste.
 */
export function resolveInternalPageTarget(
  rawTarget: string,
  fromFilePath: string | undefined,
  entries: readonly TreeEntry[],
  pages: readonly PageIdentity[],
  liveTitleDrafts?: Readonly<Record<string, string>>,
): ResolvedPageTarget | null {
  const t = rawTarget.trim().replace(/^\/+/, '');
  if (!t) return null;

  const activeFiles = entries.filter(
    (e) => e.type === 'file' && !e.archived && !isAttachmentPath(e.path),
  );
  const activeDirs = entries.filter(
    (e) => e.type === 'dir' && !e.archived && !isAttachmentPath(e.path),
  );

  const byLowerPath = new Map<string, string>();
  for (const f of activeFiles) {
    byLowerPath.set(f.path.toLowerCase(), f.path);
  }
  for (const d of activeDirs) {
    const virtualIdx = `${d.path}/_index.md`;
    if (!byLowerPath.has(virtualIdx.toLowerCase())) {
      byLowerPath.set(virtualIdx.toLowerCase(), virtualIdx);
    }
  }

  const pageByLowerPath = new Map<string, PageIdentity>();
  for (const p of pages) {
    pageByLowerPath.set(p.path.toLowerCase(), p);
  }

  const makeResult = (resolvedPath: string, knownId?: string | null): ResolvedPageTarget => {
    const rec = pageByLowerPath.get(resolvedPath.toLowerCase());
    return {
      id: knownId ?? rec?.id ?? null,
      path: resolvedPath,
      displayTitle: getNoteDisplayName(resolvedPath, liveTitleDrafts),
      ...(rec?.icona ? { icona: rec.icona } : {}),
    };
  };

  // 1. Connessione immutabile per ID: [[page:p_...]]
  if (t.toLowerCase().startsWith('page:')) {
    const pageId = t.slice(5).trim();
    const rec = pages.find((p) => p.id === pageId);
    if (!rec) return null;
    const livePath = byLowerPath.get(rec.path.toLowerCase());
    if (!livePath) return null;
    return makeResult(livePath, rec.id);
  }

  const variants = [t, `${t}.md`, `${t}/_index.md`].map((v) => v.toLowerCase());
  const fromDir = fromFilePath ? dirName(fromFilePath).toLowerCase() : '';

  // 2. Percorso diretto o relativo
  for (const v of variants) {
    const exact = byLowerPath.get(v);
    if (exact) return makeResult(exact);
  }
  if (fromDir) {
    for (const v of variants) {
      const rel = byLowerPath.get(`${fromDir}/${v}`);
      if (rel) return makeResult(rel);
    }
  }

  if (t.includes('/')) {
    for (const [low, orig] of byLowerPath.entries()) {
      if (variants.some((v) => low.endsWith(`/${v}`))) {
        return makeResult(orig);
      }
    }
  } else {
    const targetLower = t.toLowerCase();
    const sameDirHit = activeFiles.find((f) => {
      if (dirName(f.path).toLowerCase() !== fromDir) return false;
      const b = baseName(f.path).toLowerCase();
      if (b === '_index.md') return false;
      return b === targetLower || stripMdExt(b) === targetLower;
    });
    if (sameDirHit) return makeResult(sameDirHit.path);

    const sameDirNode = activeDirs.find((d) => {
      if (dirName(d.path).toLowerCase() !== fromDir) return false;
      return baseName(d.path).toLowerCase() === targetLower;
    });
    if (sameDirNode) {
      const p = byLowerPath.get(`${sameDirNode.path}/_index.md`.toLowerCase()) ?? `${sameDirNode.path}/_index.md`;
      return makeResult(p);
    }

    const anyHit = activeFiles.find((f) => {
      const b = baseName(f.path).toLowerCase();
      if (b === '_index.md') return false;
      return b === targetLower || stripMdExt(b) === targetLower;
    });
    if (anyHit) return makeResult(anyHit.path);

    const anyNode = activeDirs.find((d) => baseName(d.path).toLowerCase() === targetLower);
    if (anyNode) {
      const p = byLowerPath.get(`${anyNode.path}/_index.md`.toLowerCase()) ?? `${anyNode.path}/_index.md`;
      return makeResult(p);
    }
  }

  // 3. Ricerca nei previousPaths (conversione foglia -> nodo o rinomina legacy)
  for (const rec of pages) {
    const livePath = byLowerPath.get(rec.path.toLowerCase());
    if (!livePath || !rec.previousPaths) continue;
    for (const oldPath of rec.previousPaths) {
      const oldLower = oldPath.toLowerCase();
      const oldBase = baseName(oldPath).toLowerCase();
      if (
        variants.includes(oldLower) ||
        (!t.includes('/') &&
          oldBase !== '_index.md' &&
          (oldBase === t.toLowerCase() || stripMdExt(oldBase) === t.toLowerCase()))
      ) {
        return makeResult(livePath, rec.id);
      }
    }
  }

  return null;
}

function splitFrontmatterRaw(content: string): { prefix: string; body: string } {
  const hasBom = content.startsWith('\uFEFF');
  const clean = hasBom ? content.slice(1) : content;
  const fmMatch = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(clean);
  if (!fmMatch) {
    return { prefix: hasBom ? '\uFEFF' : '', body: clean };
  }
  const fmRaw = fmMatch[0];
  return {
    prefix: (hasBom ? '\uFEFF' : '') + fmRaw,
    body: clean.slice(fmRaw.length),
  };
}

/**
 * Elimina dal testo Markdown tutti i link interni la cui pagina di destinazione non esiste,
 * preservando intatti frontmatter, blocchi di codice, codice inline, link esterni e blocchi incorporati `![[...]]`.
 */
export function purgeMissingInternalLinksFromMarkdown(
  content: string,
  fromFilePath: string | undefined,
  entries: readonly TreeEntry[],
  pages: readonly PageIdentity[],
): string {
  if (entries.length === 0) return content;

  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = content.replace(/\r\n/g, '\n');
  const { prefix, body } = splitFrontmatterRaw(normalized);

  const lines = body.split('\n');
  const outLines: string[] = [];
  let fence: string | null = null;
  let anyChanged = false;

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]!.startsWith(fence[0]!) &&
        fenceMatch[1]!.length >= fence.length
      ) {
        fence = null;
      }
      outLines.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      outLines.push(line);
      continue;
    }

    const codeSpans: string[] = [];
    const masked = line.replace(/`+[^`\n]*`+/g, (m) => {
      const idx = codeSpans.push(m) - 1;
      return `\u0000CODE${idx}\u0000`;
    });

    let hadRemovedLinkOnLine = false;

    // 1. Wikilink [[...]] (preserva sempre gli incorporamenti ![[...]])
    let updated = masked.replace(
      /(!?)\[\[([^[\]\n]+?)\]\](\s*[—–-]\s+)?/g,
      (full, bang: string, inner: string) => {
        if (bang === '!') return full;
        const cleanInner = inner.replace(/\\\|/g, '|');
        const pipe = cleanInner.indexOf('|');
        const left = pipe === -1 ? cleanInner : cleanInner.slice(0, pipe);
        const hash = left.indexOf('#');
        const target = (hash === -1 ? left : left.slice(0, hash)).trim();
        if (!target) return full;

        const resolved = resolveInternalPageTarget(target, fromFilePath, entries, pages);
        if (resolved) return full;

        hadRemovedLinkOnLine = true;
        anyChanged = true;
        return '';
      },
    );

    // 2. Link Markdown interni [testo](percorso-interno.md) (preserva immagini ![...](...))
    updated = updated.replace(
      /(!?)\[([^\]\n]+)\]\(([^)\s\n"]+)(?:\s+"[^"\n]*")?\)(\s*[—–-]\s+)?/g,
      (full, bang: string, _label: string, rawUrl: string) => {
        if (bang === '!') return full;
        const url = rawUrl.trim();
        if (/^(https?:\/\/|mailto:|ftp:\/\/|#)/i.test(url)) {
          return full;
        }
        const hash = url.indexOf('#');
        const pathPart = (hash === -1 ? url : url.slice(0, hash)).trim();
        if (!pathPart) return full;

        const resolved = resolveInternalPageTarget(pathPart, fromFilePath, entries, pages);
        if (resolved) return full;

        hadRemovedLinkOnLine = true;
        anyChanged = true;
        return '';
      },
    );

    updated = updated.replace(
      /\u0000CODE(\d+)\u0000/g,
      (_m, idxStr) => codeSpans[Number(idxStr)] ?? '',
    );

    if (hadRemovedLinkOnLine) {
      const prefixMatch = updated.match(/^(\s*(?:-\s+\[[ xX]\]\s*|[-*]\s+|\d+[.)]\s+|>\s*)?)/);
      const lead = prefixMatch ? prefixMatch[0] : '';
      const rest = updated
        .slice(lead.length)
        .replace(/^[—–-]\s+/, '')
        .replace(/ {2,}/g, ' ')
        .trim();

      if (!rest) {
        continue;
      }
      outLines.push(`${lead}${rest}`);
    } else {
      outLines.push(line);
    }
  }

  if (!anyChanged) return content;
  const rebuilt = prefix + outLines.join('\n');
  return eol === '\r\n' ? rebuilt.replace(/\n/g, '\r\n') : rebuilt;
}
