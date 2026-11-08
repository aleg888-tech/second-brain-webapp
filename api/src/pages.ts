import { randomBytes } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ATTACHMENTS_DIR,
  extractVistaBlocks,
  isUnder,
  maskCode,
  parseFrontmatterYaml,
  type KbService,
} from '@brain/kb-core';
import type { DuplicateIdWarning, PageIdentity, TreeEntry } from '@brain/shared';

interface StoredPagesFile {
  pages: Array<{
    id: string;
    path: string;
    previousPaths?: string[];
  }>;
}

interface CachedMdMeta {
  size: number;
  mtimeMs: number;
  icona: string | null;
  copertina: string | null;
  tipo: string | null;
  frontmatterId: string | null;
  embeddedDatabaseIds: string[];
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

function extractEmbeddedDatabaseIds(body: string): string[] {
  const masked = maskCode(body.replace(/\r\n/g, '\n'));
  const ids = new Set<string>();
  const re = /^[ \t]*!\[\[page:([^[\]\n|#]+)\]\][ \t]*$/gm;
  for (const m of masked.matchAll(re)) {
    const id = m[1]?.trim();
    if (id) ids.add(id);
  }
  for (const b of extractVistaBlocks(body)) {
    if (b.parsed.ok && b.parsed.source.type === 'database' && b.parsed.source.targetId) {
      ids.add(b.parsed.source.targetId);
    }
  }
  return [...ids];
}

export function isAttachmentEntry(path: string): boolean {
  return isUnder(path, ATTACHMENTS_DIR);
}

export class PageRegistry {
  private readonly filePath: string;
  private loaded = false;
  private records: PageIdentity[] = [];
  private metaCache = new Map<string, CachedMdMeta>();
  private lastDuplicates: DuplicateIdWarning[] = [];

  constructor(private readonly projectRoot: string) {
    this.filePath = resolve(projectRoot, '.brain', 'pages.json');
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.filePath)) return;
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<StoredPagesFile>;
      if (Array.isArray(parsed.pages)) {
        this.records = parsed.pages
          .filter(
            (p): p is PageIdentity =>
              Boolean(p) && typeof p.id === 'string' && typeof p.path === 'string',
          )
          .map((p) => ({
            id: p.id,
            path: p.path,
            previousPaths: Array.isArray(p.previousPaths)
              ? p.previousPaths.filter((x): x is string => typeof x === 'string')
              : [],
          }));
      }
    } catch {
      this.records = [];
    }
  }

  private async persist(): Promise<void> {
    if (!existsSync(this.projectRoot)) return;
    try {
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      const data: StoredPagesFile = {
        pages: this.records.map((r) => ({
          id: r.id,
          path: r.path,
          ...(r.previousPaths && r.previousPaths.length > 0
            ? { previousPaths: r.previousPaths }
            : {}),
        })),
      };
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    } catch {
      // ignore persistence errors in read-only or dummy test environments
    }
  }

  allocateId(preferredId?: string | null): string {
    const existing = new Set(this.records.map((r) => r.id));
    if (preferredId && /^p_[a-zA-Z0-9_-]+$/.test(preferredId) && !existing.has(preferredId)) {
      return preferredId;
    }
    for (;;) {
      const id = `p_${randomBytes(5).toString('hex')}`;
      if (!existing.has(id)) return id;
    }
  }

  getDuplicateWarnings(): DuplicateIdWarning[] {
    return this.lastDuplicates.map((d) => ({ id: d.id, paths: [...d.paths] }));
  }

  private async inspectMdMeta(entry: TreeEntry, kb?: KbService): Promise<CachedMdMeta> {
    const key = entry.path.toLowerCase();
    const cached = this.metaCache.get(key);
    if (cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs) {
      return cached;
    }
    const empty: CachedMdMeta = {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      icona: null,
      copertina: null,
      tipo: null,
      frontmatterId: null,
      embeddedDatabaseIds: [],
    };
    if (!kb || !entry.path.toLowerCase().endsWith('.md')) {
      return empty;
    }
    try {
      const file = await kb.read(entry.path);
      const parsed = parseFrontmatterYaml(file.content);
      const icona =
        typeof parsed.data.icona === 'string' && parsed.data.icona.trim() !== ''
          ? parsed.data.icona.trim()
          : null;
      const copertina =
        typeof parsed.data.copertina === 'string' && parsed.data.copertina.trim() !== ''
          ? parsed.data.copertina.trim()
          : null;
      const tipo =
        typeof parsed.data.tipo === 'string' && parsed.data.tipo.trim() !== ''
          ? parsed.data.tipo.trim()
          : null;
      const frontmatterId =
        typeof parsed.data.id === 'string' && parsed.data.id.trim() !== ''
          ? parsed.data.id.trim()
          : null;
      const embeddedDatabaseIds = extractEmbeddedDatabaseIds(parsed.body);
      const computed: CachedMdMeta = {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        icona,
        copertina,
        tipo,
        frontmatterId,
        embeddedDatabaseIds,
      };
      this.metaCache.set(key, computed);
      return computed;
    } catch {
      return empty;
    }
  }

  invalidateMeta(path: string): void {
    this.metaCache.delete(path.toLowerCase());
  }

  async syncWithTree(entries: TreeEntry[], kb?: KbService): Promise<PageIdentity[]> {
    await this.ensureLoaded();

    const activeFiles = entries.filter(
      (e) => e.type === 'file' && !e.archived && !isAttachmentEntry(e.path),
    );
    const activeDirs = entries.filter(
      (e) => e.type === 'dir' && !e.archived && !isAttachmentEntry(e.path),
    );

    const activeByLower = new Map<string, { path: string; virtual: boolean; entry: TreeEntry }>();
    for (const f of activeFiles) {
      activeByLower.set(f.path.toLowerCase(), { path: f.path, virtual: false, entry: f });
    }
    // Cartelle esistenti prive di _index.md: appaiono come pagine virtuali senza creare _index.md su disco
    for (const d of activeDirs) {
      const virtualIndexPath = `${d.path}/_index.md`;
      if (!activeByLower.has(virtualIndexPath.toLowerCase())) {
        activeByLower.set(virtualIndexPath.toLowerCase(), {
          path: virtualIndexPath,
          virtual: true,
          entry: d,
        });
      }
    }

    // Pulisce cache metadati di file non più attivi
    for (const k of [...this.metaCache.keys()]) {
      if (!activeByLower.has(k)) {
        this.metaCache.delete(k);
      }
    }

    // Estrae metadati frontmatter per tutti i .md reali
    const metaByLower = new Map<string, CachedMdMeta>();
    const fmIdToPaths = new Map<string, string[]>();
    for (const item of activeByLower.values()) {
      if (!item.virtual && item.path.toLowerCase().endsWith('.md')) {
        const meta = await this.inspectMdMeta(item.entry, kb);
        metaByLower.set(item.path.toLowerCase(), meta);
        if (meta.frontmatterId) {
          const list = fmIdToPaths.get(meta.frontmatterId) ?? [];
          list.push(item.path);
          fmIdToPaths.set(meta.frontmatterId, list);
        }
      }
    }

    // Rileva id duplicati nel frontmatter (es. file copiati a mano) senza correggerli di nascosto
    const duplicates: DuplicateIdWarning[] = [];
    const duplicatedIdSet = new Set<string>();
    for (const [fmId, paths] of fmIdToPaths.entries()) {
      if (paths.length > 1) {
        duplicatedIdSet.add(fmId);
        duplicates.push({ id: fmId, paths: [...paths].sort() });
      }
    }
    this.lastDuplicates = duplicates;

    let changed = false;
    const kept: PageIdentity[] = [];
    const coveredLower = new Set<string>();
    const usedIds = new Set<string>();

    // 1. Allinea prima i record esistenti nel registro
    for (const rec of this.records) {
      const lower = rec.path.toLowerCase();
      const match = activeByLower.get(lower);
      if (!match || coveredLower.has(lower)) {
        changed = true;
        continue;
      }
      coveredLower.add(lower);
      if (rec.path !== match.path) {
        rec.path = match.path;
        changed = true;
      }
      const meta = metaByLower.get(lower);
      // Se il file ha un `id:` esplicito e univoco nel frontmatter, il frontmatter è la fonte di verità
      if (
        meta?.frontmatterId &&
        !duplicatedIdSet.has(meta.frontmatterId) &&
        rec.id !== meta.frontmatterId &&
        !usedIds.has(meta.frontmatterId)
      ) {
        rec.id = meta.frontmatterId;
        changed = true;
      }
      usedIds.add(rec.id);
      kept.push({
        id: rec.id,
        path: rec.path,
        previousPaths: rec.previousPaths ? [...rec.previousPaths] : [],
        icona: meta?.icona ?? null,
        copertina: meta?.copertina ?? null,
        tipo: meta?.tipo ?? null,
        frontmatterId: meta?.frontmatterId ?? null,
        virtual: match.virtual,
        embeddedDatabaseIds: meta?.embeddedDatabaseIds ?? [],
      });
    }

    // 2. Registra le pagine nuove o ricostruite dai file su disco (in ordine deterministico)
    const sortedActive = [...activeByLower.entries()].sort((a, b) =>
      a[1].path.localeCompare(b[1].path),
    );
    for (const [lower, item] of sortedActive) {
      if (coveredLower.has(lower)) continue;
      const meta = metaByLower.get(lower);
      let chosenId: string | null = null;
      if (meta?.frontmatterId && !usedIds.has(meta.frontmatterId)) {
        chosenId = meta.frontmatterId;
      }
      if (!chosenId) {
        for (;;) {
          const cand = `p_${randomBytes(5).toString('hex')}`;
          if (!usedIds.has(cand) && !fmIdToPaths.has(cand)) {
            chosenId = cand;
            break;
          }
        }
      }
      usedIds.add(chosenId);
      coveredLower.add(lower);
      kept.push({
        id: chosenId,
        path: item.path,
        previousPaths: [],
        icona: meta?.icona ?? null,
        copertina: meta?.copertina ?? null,
        tipo: meta?.tipo ?? null,
        frontmatterId: meta?.frontmatterId ?? null,
        virtual: item.virtual,
        embeddedDatabaseIds: meta?.embeddedDatabaseIds ?? [],
      });
      changed = true;
    }

    this.records = kept;
    if (changed) {
      await this.persist();
    }

    return this.snapshot();
  }

  async ensurePage(path: string, preferredId?: string | null): Promise<PageIdentity> {
    await this.ensureLoaded();
    const lower = path.toLowerCase();
    let found = this.records.find((r) => r.path.toLowerCase() === lower);
    if (!found) {
      found = {
        id: this.allocateId(preferredId),
        path,
        previousPaths: [],
      };
      this.records.push(found);
      await this.persist();
    } else {
      let updated = false;
      if (found.path !== path) {
        found.path = path;
        updated = true;
      }
      if (
        preferredId &&
        found.id !== preferredId &&
        !this.records.some((r) => r !== found && r.id === preferredId)
      ) {
        found.id = preferredId;
        updated = true;
      }
      if (updated) {
        await this.persist();
      }
    }
    return {
      id: found.id,
      path: found.path,
      previousPaths: [...(found.previousPaths ?? [])],
      icona: found.icona ?? null,
      copertina: found.copertina ?? null,
      tipo: found.tipo ?? null,
      frontmatterId: found.frontmatterId ?? null,
      virtual: found.virtual ?? false,
      embeddedDatabaseIds: found.embeddedDatabaseIds ? [...found.embeddedDatabaseIds] : [],
    };
  }

  async onRename(fromPath: string, toPath: string): Promise<void> {
    await this.ensureLoaded();
    const fromLower = fromPath.toLowerCase();
    const toLower = toPath.toLowerCase();
    let changed = false;

    for (const rec of this.records) {
      const recLower = rec.path.toLowerCase();
      if (recLower === fromLower) {
        if (fromLower !== toLower) {
          const prev = rec.previousPaths ?? [];
          if (!prev.some((p) => p.toLowerCase() === recLower)) {
            prev.push(rec.path);
          }
          rec.previousPaths = prev.filter((p) => p.toLowerCase() !== toLower);
        }
        this.metaCache.delete(recLower);
        rec.path = toPath;
        changed = true;
      } else if (recLower.startsWith(`${fromLower}/`)) {
        const nextChild = `${toPath}${rec.path.slice(fromPath.length)}`;
        const nextLower = nextChild.toLowerCase();
        if (recLower !== nextLower) {
          const prev = rec.previousPaths ?? [];
          if (!prev.some((p) => p.toLowerCase() === recLower)) {
            prev.push(rec.path);
          }
          rec.previousPaths = prev.filter((p) => p.toLowerCase() !== nextLower);
        }
        this.metaCache.delete(recLower);
        rec.path = nextChild;
        changed = true;
      }
    }

    if (changed) {
      await this.persist();
    }
  }

  async onDelete(deletedPath: string): Promise<void> {
    await this.ensureLoaded();
    const delLower = deletedPath.toLowerCase();
    const beforeLen = this.records.length;
    this.records = this.records.filter((rec) => {
      const l = rec.path.toLowerCase();
      if (l === delLower || l.startsWith(`${delLower}/`)) {
        this.metaCache.delete(l);
        return false;
      }
      return true;
    });
    for (const rec of this.records) {
      if (rec.previousPaths && rec.previousPaths.length > 0) {
        rec.previousPaths = rec.previousPaths.filter((p) => {
          const l = p.toLowerCase();
          return l !== delLower && !l.startsWith(`${delLower}/`);
        });
      }
    }
    if (this.records.length !== beforeLen) {
      await this.persist();
    }
  }

  snapshot(): PageIdentity[] {
    return this.records.map((r) => ({
      id: r.id,
      path: r.path,
      ...(r.previousPaths && r.previousPaths.length > 0
        ? { previousPaths: [...r.previousPaths] }
        : {}),
      ...(r.icona ? { icona: r.icona } : {}),
      ...(r.copertina ? { copertina: r.copertina } : {}),
      ...(r.tipo ? { tipo: r.tipo } : {}),
      ...(r.frontmatterId ? { frontmatterId: r.frontmatterId } : {}),
      ...(r.virtual ? { virtual: true } : {}),
      ...(r.embeddedDatabaseIds && r.embeddedDatabaseIds.length > 0
        ? { embeddedDatabaseIds: [...r.embeddedDatabaseIds] }
        : {}),
    }));
  }

  resolveTargetToExistingPath(
    rawTarget: string,
    fromFilePath: string,
    activeEntries: readonly TreeEntry[],
  ): string | null {
    const t = rawTarget.trim().replace(/^\/+/, '');
    if (!t) return null;

    const activeFiles = activeEntries.filter(
      (e) => e.type === 'file' && !e.archived && !isAttachmentEntry(e.path),
    );
    const activeDirs = activeEntries.filter(
      (e) => e.type === 'dir' && !e.archived && !isAttachmentEntry(e.path),
    );

    const byLowerPath = new Map<string, string>();
    for (const f of activeFiles) {
      byLowerPath.set(f.path.toLowerCase(), f.path);
    }
    for (const d of activeDirs) {
      const idx = `${d.path}/_index.md`;
      if (!byLowerPath.has(idx.toLowerCase())) {
        byLowerPath.set(idx.toLowerCase(), idx);
      }
    }

    // 1. Connessione stabile per ID pagina: [[page:p_...]]
    if (t.toLowerCase().startsWith('page:')) {
      const pageId = t.slice(5).trim();
      const rec = this.records.find((r) => r.id === pageId);
      if (!rec) return null;
      return byLowerPath.get(rec.path.toLowerCase()) ?? null;
    }

    const variants = [t, `${t}.md`, `${t}/_index.md`].map((v) => v.toLowerCase());
    const fromDir = dirName(fromFilePath).toLowerCase();

    // 2. Corrispondenza per percorso esatto o relativo
    for (const v of variants) {
      const exact = byLowerPath.get(v);
      if (exact) return exact;
    }
    if (fromDir) {
      for (const v of variants) {
        const rel = byLowerPath.get(`${fromDir}/${v}`);
        if (rel) return rel;
      }
    }

    if (t.includes('/')) {
      for (const [low, orig] of byLowerPath.entries()) {
        if (variants.some((v) => low.endsWith(`/${v}`))) {
          return orig;
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
      if (sameDirHit) return sameDirHit.path;

      const sameDirNode = activeDirs.find((d) => {
        if (dirName(d.path).toLowerCase() !== fromDir) return false;
        return baseName(d.path).toLowerCase() === targetLower;
      });
      if (sameDirNode) {
        return byLowerPath.get(`${sameDirNode.path}/_index.md`.toLowerCase()) ?? `${sameDirNode.path}/_index.md`;
      }

      const anyNameHit = activeFiles.find((f) => {
        const b = baseName(f.path).toLowerCase();
        if (b === '_index.md') return false;
        return b === targetLower || stripMdExt(b) === targetLower;
      });
      if (anyNameHit) return anyNameHit.path;

      const anyDirNode = activeDirs.find((d) => baseName(d.path).toLowerCase() === targetLower);
      if (anyDirNode) {
        return byLowerPath.get(`${anyDirNode.path}/_index.md`.toLowerCase()) ?? `${anyDirNode.path}/_index.md`;
      }
    }

    // 3. Corrispondenza tramite previousPaths (es. conversione foglia -> nodo o rinomina legacy)
    for (const rec of this.records) {
      const currentLive = byLowerPath.get(rec.path.toLowerCase());
      if (!currentLive || !rec.previousPaths) continue;
      for (const oldPath of rec.previousPaths) {
        const oldLower = oldPath.toLowerCase();
        const oldBase = baseName(oldPath).toLowerCase();
        if (
          variants.includes(oldLower) ||
          (!t.includes('/') &&
            oldBase !== '_index.md' &&
            (oldBase === t.toLowerCase() || stripMdExt(oldBase) === t.toLowerCase()))
        ) {
          return currentLive;
        }
      }
    }

    return null;
  }

  purgeLinksToMissingPagesInContent(
    content: string,
    fromFilePath: string,
    activeEntries: readonly TreeEntry[],
  ): string {
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
        if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) {
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

      // 1. Wikilinks [[...]] (NON rimuovere mai i blocchi incorporati ![[...]])
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

          const resolved = this.resolveTargetToExistingPath(target, fromFilePath, activeEntries);
          if (resolved) return full;

          hadRemovedLinkOnLine = true;
          anyChanged = true;
          return '';
        },
      );

      // 2. Link Markdown interni [testo](percorso-interno.md) (esclude immagini ![...](...))
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

          const resolved = this.resolveTargetToExistingPath(pathPart, fromFilePath, activeEntries);
          if (resolved) return full;

          hadRemovedLinkOnLine = true;
          anyChanged = true;
          return '';
        },
      );

      updated = updated.replace(/\u0000CODE(\d+)\u0000/g, (_m, idxStr) => codeSpans[Number(idxStr)] ?? '');

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

  async purgeBrokenLinksAcrossKb(kb: KbService): Promise<void> {
    const entries = await kb.tree(false);
    await this.syncWithTree(entries, kb);
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.path.toLowerCase().endsWith('.md')) continue;
      if (kb.isPathDenied(entry.path)) continue;
      try {
        const file = await kb.read(entry.path);
        const cleaned = this.purgeLinksToMissingPagesInContent(file.content, entry.path, entries);
        if (cleaned !== file.content) {
          // Passa sempre da kb-core (controllo versione + snapshot nello storico)
          await kb.write(entry.path, cleaned, file.version);
          this.invalidateMeta(entry.path);
        }
      } catch {
        // ignore concurrent or inaccessible files
      }
    }
  }
}
