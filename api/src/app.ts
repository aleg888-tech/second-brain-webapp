import { existsSync, promises as fs } from 'node:fs';
import { dirname as nodeDirname, resolve as nodeResolve } from 'node:path';
import { Hono } from 'hono';
import {
  AppError,
  ATTACHMENTS_DIR,
  badRequest,
  extOf,
  forbidden,
  invalidPath,
  normalizeRelPath,
  notFound,
  parseFrontmatterYaml,
  patchFrontmatterField,
  VIRTUAL_INDEX_VERSION,
  type KbService,
} from '@brain/kb-core';
import type {
  AgentStatus,
  AlignIdsRequest,
  AlignIdsResponse,
  ArchiveRequest,
  AttachmentListResponse,
  AttachmentUploadRequest,
  AttachmentUploadResponse,
  ConfigResponse,
  ConvertLeafToNodeRequest,
  ConvertLeafToNodeResponse,
  CreateDatabaseRequest,
  CreateDatabaseRowRequest,
  CreateDirRequest,
  CreateFileRequest,
  CreateSubpageRequest,
  CreateSubpageResponse,
  FrontmatterPatchRequest,
  HistoryListResponse,
  HistoryVersionResponse,
  RenameRequest,
  RestoreRequest,
  SchemaOperationRequest,
  StatusResponse,
  TableQueryRequest,
  TagsResponse,
  TreeResponse,
  WriteFileRequest,
} from '@brain/shared';
import type { AppConfig } from './config.js';
import {
  createDatabaseInPage,
  createDatabaseRow,
  executeDatabaseSchemaOperation,
  queryTableView,
} from './databases.js';
import { PageRegistry } from './pages.js';
import { createSecurityMiddleware } from './security.js';
import { VistaStore } from './vista.js';

export interface AppDependencies {
  config: AppConfig;
  kb: KbService;
  token: string;
}

export function createApp(deps: AppDependencies): Hono {
  const { config, kb, token } = deps;
  const app = new Hono();

  const vistaStore = new VistaStore(config.vistaJsonPath);
  const pageRegistry = new PageRegistry(config.projectRoot);

  function isMarkdownPageWithId(relPath: string): boolean {
    const lower = relPath.trim().replace(/^\/+/, '').toLowerCase();
    return (
      lower.endsWith('.md') &&
      lower !== 'agents.md' &&
      !lower.startsWith(`${ATTACHMENTS_DIR}/`)
    );
  }

  async function prepareNewMarkdownPageWithId(
    relPath: string,
    rawContent: string,
  ): Promise<{ content: string; pageId?: string }> {
    const normRel = kb.filePath(relPath);
    if (!isMarkdownPageWithId(normRel)) {
      return { content: rawContent };
    }
    const parsed = parseFrontmatterYaml(rawContent);
    const existingFmId =
      typeof parsed.data.id === 'string' && parsed.data.id.trim() !== ''
        ? parsed.data.id.trim()
        : null;
    if (existingFmId) {
      const page = await pageRegistry.ensurePage(normRel, existingFmId);
      return { content: rawContent, pageId: page.id };
    }
    const page = await pageRegistry.ensurePage(normRel);
    const contentWithId = patchFrontmatterField(rawContent, 'id', page.id, { insertAtTop: true });
    return { content: contentWithId, pageId: page.id };
  }

  const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
  const MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  };

  function sanitizePageFileStem(raw: string): string {
    // eslint-disable-next-line no-control-regex
    const cleaned = raw
      .replace(/[<>:"/\\|?*%\u0000-\u001f]/g, '')
      .replace(/^[\s.]+/, '')
      .replace(/[\s.]+$/, '');
    if (!cleaned) return '';
    const reserved = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
    const stem = cleaned.split('.')[0] ?? cleaned;
    if (reserved.test(stem)) return '';
    return cleaned;
  }

  function pickUniqueChildPagePath(
    parentDir: string,
    desiredTitle: string | undefined,
    entries: readonly import('@brain/shared').TreeEntry[],
  ): string {
    const cleanParent = parentDir.replace(/^\/+|\/+$/g, '');
    const prefix = cleanParent ? `${cleanParent}/` : '';
    const baseTitle = sanitizePageFileStem(desiredTitle ?? '') || 'Nuova pagina';
    const occupiedLower = new Set<string>();
    for (const e of entries) {
      if (e.archived) continue;
      occupiedLower.add(e.path.toLowerCase());
    }
    let candidateStem = baseTitle;
    let counter = 2;
    while (
      occupiedLower.has(`${prefix}${candidateStem}.md`.toLowerCase()) ||
      occupiedLower.has(`${prefix}${candidateStem}`.toLowerCase())
    ) {
      candidateStem = `${baseTitle} ${counter}`;
      counter++;
    }
    return `${prefix}${candidateStem}.md`;
  }

  // Gestione centralizzata errori
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.current ? { current: err.current } : {}),
          },
        },
        err.status as any,
      );
    }
    console.error('[API Error]', err);
    return c.json(
      {
        error: {
          code: 'internal',
          message: err instanceof Error ? err.message : 'Errore interno del server.',
        },
      },
      500,
    );
  });

  // Sicurezza: Host, Origin, CORS e Token
  app.use('*', createSecurityMiddleware(config, token));

  // -------------------------------------------------------------------------
  // Stato e Configurazione
  // -------------------------------------------------------------------------

  app.get('/v1/status', async (c) => {
    const status = await kb.status();
    const res: StatusResponse = status;
    return c.json(res);
  });

  app.get('/v1/config', (c) => {
    const res: ConfigResponse = {
      extensions: [...config.extensions],
      archiveDir: kb.archiveDir,
      agentDeny: [...config.agentDeny],
    };
    return c.json(res);
  });

  // -------------------------------------------------------------------------
  // Albero e File
  // -------------------------------------------------------------------------

  app.get('/v1/tree', async (c) => {
    const includeArchived = c.req.query('all') === 'true';
    const entries = await kb.tree(includeArchived);
    const pages = await pageRegistry.syncWithTree(entries, kb);
    const duplicateIds = pageRegistry.getDuplicateWarnings();
    const res: TreeResponse = {
      entries,
      pages,
      ...(duplicateIds.length > 0 ? { duplicateIds } : {}),
    };
    return c.json(res);
  });

  app.get('/v1/files/content', async (c) => {
    const path = c.req.query('path');
    if (!path) throw badRequest('Parametro "path" obbligatorio.');
    const file = await kb.readOrVirtualIndex(path);
    return c.json(file);
  });

  app.post('/v1/files/content', async (c) => {
    const body = await c.req.json<WriteFileRequest>().catch(() => null);
    if (!body || typeof body.path !== 'string') {
      throw badRequest('Corpo non valido: "path", "content" e "baseVersion" sono obbligatori.');
    }
    const entries = await kb.tree(false);
    await pageRegistry.syncWithTree(entries, kb);
    let sanitizedContent = body.path.toLowerCase().endsWith('.md')
      ? pageRegistry.purgeLinksToMissingPagesInContent(body.content, body.path, entries)
      : body.content;

    // Se stiamo materializzando per la prima volta un _index.md virtuale con contenuto non vuoto,
    // scriviamo subito anche `id: p_...` nel frontmatter.
    if (
      body.baseVersion === VIRTUAL_INDEX_VERSION &&
      sanitizedContent.trim() !== '' &&
      body.path.toLowerCase().endsWith('/_index.md')
    ) {
      const prepared = await prepareNewMarkdownPageWithId(body.path, sanitizedContent);
      sanitizedContent = prepared.content;
    }

    const result = await kb.write(body.path, sanitizedContent, body.baseVersion);
    pageRegistry.invalidateMeta(result.file.path);
    const page = await pageRegistry.ensurePage(result.file.path);
    return c.json({
      ...result,
      pageId: page.id,
      ...(sanitizedContent !== body.content ? { content: sanitizedContent } : {}),
    });
  });

  app.post('/v1/files/frontmatter-patch', async (c) => {
    const body = await c.req.json<FrontmatterPatchRequest>().catch(() => null);
    if (!body || typeof body.path !== 'string' || typeof body.key !== 'string') {
      throw badRequest('Corpo non valido: "path", "key" e "baseVersion" sono obbligatori.');
    }
    const entries = await kb.tree(false);
    await pageRegistry.syncWithTree(entries, kb);

    // Se il nodo è virtuale (_index.md non ancora su disco) e stiamo impostando un campo (es. icona o proprietà),
    // materializziamo subito il file includendo anche `id: p_...` in cima al frontmatter.
    if (
      body.baseVersion === VIRTUAL_INDEX_VERSION &&
      !body.unset &&
      body.key.trim() !== 'id' &&
      body.path.toLowerCase().endsWith('/_index.md')
    ) {
      const normPath = kb.filePath(body.path);
      const page = await pageRegistry.ensurePage(normPath);
      const withId = patchFrontmatterField('', 'id', page.id, { insertAtTop: true });
      const patched = patchFrontmatterField(withId, body.key, body.value);
      const writeRes = await kb.write(normPath, patched, VIRTUAL_INDEX_VERSION);
      pageRegistry.invalidateMeta(writeRes.file.path);
      return c.json({
        ...writeRes,
        content: patched,
        pageId: page.id,
      });
    }

    const result = await kb.patchFrontmatter(
      body.path,
      body.key,
      body.value,
      body.baseVersion,
      { unset: Boolean(body.unset) },
    );
    pageRegistry.invalidateMeta(result.file.path);
    const page = await pageRegistry.ensurePage(result.file.path);
    return c.json({ ...result, pageId: page.id });
  });

  app.post('/v1/files/create', async (c) => {
    const body = await c.req.json<CreateFileRequest>().catch(() => null);
    if (!body || typeof body.path !== 'string') {
      throw badRequest('Corpo non valido: "path" obbligatorio.');
    }
    const entries = await kb.tree(false);
    await pageRegistry.syncWithTree(entries, kb);
    const rawContent = body.content ?? '';
    let sanitizedContent = rawContent;
    if (rawContent && body.path.toLowerCase().endsWith('.md')) {
      sanitizedContent = pageRegistry.purgeLinksToMissingPagesInContent(
        rawContent,
        body.path,
        entries,
      );
    }
    const prepared = await prepareNewMarkdownPageWithId(body.path, sanitizedContent);
    const result = await kb.create(body.path, prepared.content);
    pageRegistry.invalidateMeta(result.file.path);
    const page = await pageRegistry.ensurePage(result.file.path, prepared.pageId);
    return c.json({ ...result, pageId: page.id, content: prepared.content });
  });

  app.post('/v1/pages/convert-to-node', async (c) => {
    const body = await c.req.json<ConvertLeafToNodeRequest>().catch(() => null);
    if (!body || typeof body.path !== 'string') {
      throw badRequest('Corpo non valido: "path" obbligatorio.');
    }
    const entriesBefore = await kb.tree(false);
    await pageRegistry.syncWithTree(entriesBefore, kb);
    const conv = await kb.convertLeafToNode(body.path);
    await pageRegistry.onRename(conv.from, conv.to);
    const page = await pageRegistry.ensurePage(conv.to);
    const res: ConvertLeafToNodeResponse = {
      from: conv.from,
      to: conv.to,
      pageId: page.id,
      historyId: conv.historyId,
      file: conv.file,
    };
    return c.json(res);
  });

  app.post('/v1/pages/create-subpage', async (c) => {
    const body = await c.req.json<CreateSubpageRequest>().catch(() => null);
    if (!body || typeof body.parentPath !== 'string') {
      throw badRequest('Corpo non valido: "parentPath" obbligatorio.');
    }
    const entriesBefore = await kb.tree(false);
    await pageRegistry.syncWithTree(entriesBefore, kb);

    let convertedParent: CreateSubpageResponse['convertedParent'];
    let targetDir = '';
    const trimmedParent = body.parentPath.trim();

    if (trimmedParent === '' || trimmedParent.toLowerCase() === '_index.md') {
      targetDir = '';
    } else if (trimmedParent.toLowerCase().endsWith('/_index.md')) {
      targetDir = kb.dirPath(trimmedParent.slice(0, -'/_index.md'.length));
      // Se la cartella non esiste ancora fisicamente, la crea prima di aggiungere il figlio
      const existingDir = entriesBefore.some(
        (e) => e.type === 'dir' && e.path.toLowerCase() === targetDir.toLowerCase(),
      );
      if (!existingDir) {
        await kb.createDir(targetDir);
      }
    } else if (trimmedParent.toLowerCase().endsWith('.md')) {
      // Conversione atomica foglia -> nodo
      const conv = await kb.convertLeafToNode(trimmedParent);
      await pageRegistry.onRename(conv.from, conv.to);
      convertedParent = {
        from: conv.from,
        to: conv.to,
        historyId: conv.historyId,
      };
      targetDir = conv.to.slice(0, -'/_index.md'.length);
    } else {
      targetDir = kb.dirPath(trimmedParent);
    }

    const entriesNow = await kb.tree(false);
    const childPath = pickUniqueChildPagePath(targetDir, body.title, entriesNow);
    const preparedChild = await prepareNewMarkdownPageWithId(childPath, body.content ?? '');
    const created = await kb.create(childPath, preparedChild.content);
    pageRegistry.invalidateMeta(created.file.path);
    const childPage = await pageRegistry.ensurePage(created.file.path, preparedChild.pageId);

    const res: CreateSubpageResponse = {
      ...(convertedParent ? { convertedParent } : {}),
      created: {
        ...created,
        pageId: childPage.id,
        content: preparedChild.content,
      },
    };
    return c.json(res);
  });

  // Comando esplicito "Allinea id": scrive `id: p_...` nel frontmatter delle pagine esistenti prive di id,
  // sempre con anteprima (dryRun=true predefinito), snapshot nello storico e segnalazione duplicati senza toccarli.
  app.post('/v1/pages/align-ids', async (c) => {
    const body = await c.req.json<AlignIdsRequest>().catch(() => ({} as AlignIdsRequest));
    const dryRun = body?.dryRun !== false;

    const entries = await kb.tree(false);
    await pageRegistry.syncWithTree(entries, kb);
    const duplicates = pageRegistry.getDuplicateWarnings();
    const duplicatePathsLower = new Set<string>();
    for (const d of duplicates) {
      for (const p of d.paths) duplicatePathsLower.add(p.toLowerCase());
    }

    const missingPaths: string[] = [];
    for (const entry of entries) {
      if (entry.type !== 'file' || entry.archived) continue;
      if (!isMarkdownPageWithId(entry.path)) continue;
      if (duplicatePathsLower.has(entry.path.toLowerCase())) continue;

      const file = await kb.read(entry.path);
      const parsed = parseFrontmatterYaml(file.content);
      const hasValidId =
        typeof parsed.data.id === 'string' && parsed.data.id.trim().length > 0;
      if (!hasValidId && parsed.errors.length === 0) {
        missingPaths.push(entry.path);
      }
    }
    missingPaths.sort((a, b) => a.localeCompare(b));

    if (dryRun) {
      const res: AlignIdsResponse = {
        dryRun: true,
        count: missingPaths.length,
        paths: missingPaths,
        modified: [],
        duplicates,
      };
      return c.json(res);
    }

    const modified: AlignIdsResponse['modified'] = [];
    for (const p of missingPaths) {
      const cur = await kb.read(p);
      const page = await pageRegistry.ensurePage(p);
      const patched = await kb.patchFrontmatter(p, 'id', page.id, cur.version, {
        insertAtTop: true,
      });
      pageRegistry.invalidateMeta(p);
      modified.push({
        path: p,
        pageId: page.id,
        historyId: patched.historyId,
      });
    }

    const freshEntries = await kb.tree(false);
    await pageRegistry.syncWithTree(freshEntries, kb);

    const res: AlignIdsResponse = {
      dryRun: false,
      count: modified.length,
      paths: missingPaths,
      modified,
      duplicates: pageRegistry.getDuplicateWarnings(),
    };
    return c.json(res);
  });

  // -------------------------------------------------------------------------
  // Database e Viste a Tabella (per-tabella, senza catalogo globale)
  // -------------------------------------------------------------------------

  app.post('/v1/databases/create', async (c) => {
    const body = await c.req.json<CreateDatabaseRequest>().catch(() => null);
    if (!body || typeof body.hostPath !== 'string') {
      throw badRequest('Corpo non valido: "hostPath" obbligatorio.');
    }
    const res = await createDatabaseInPage(kb, pageRegistry, body);
    return c.json(res);
  });

  app.get('/v1/databases/:dbId', async (c) => {
    const dbId = c.req.param('dbId');
    const res = await queryTableView(kb, pageRegistry, {
      vista: { fonte: `database ${dbId}` },
    });
    return c.json(res);
  });

  app.post('/v1/databases/:dbId/schema-op', async (c) => {
    const dbId = c.req.param('dbId');
    const body = await c.req.json<SchemaOperationRequest>().catch(() => null);
    if (!body || typeof body.op !== 'string') {
      throw badRequest('Corpo non valido: "op" obbligatorio.');
    }
    const res = await executeDatabaseSchemaOperation(kb, pageRegistry, dbId, body);
    return c.json(res);
  });

  app.post('/v1/databases/:dbId/rows', async (c) => {
    const dbId = c.req.param('dbId');
    const body = await c.req
      .json<CreateDatabaseRowRequest>()
      .catch(() => ({} as CreateDatabaseRowRequest));
    const res = await createDatabaseRow(kb, pageRegistry, dbId, body ?? {});
    return c.json(res);
  });

  app.post('/v1/views/query', async (c) => {
    const body = await c.req.json<TableQueryRequest>().catch(() => null);
    if (!body || !body.vista || typeof body.vista.fonte !== 'string') {
      throw badRequest('Corpo non valido: "vista.fonte" obbligatorio.');
    }
    const res = await queryTableView(kb, pageRegistry, body);
    return c.json(res);
  });

  app.post('/v1/folders/create', async (c) => {
    const body = await c.req.json<CreateDirRequest>().catch(() => null);
    if (!body || typeof body.path !== 'string') {
      throw badRequest('Corpo non valido: "path" obbligatorio.');
    }
    const result = await kb.createDir(body.path);
    return c.json({ success: true, ...result });
  });

  app.post('/v1/files/rename', async (c) => {
    const body = await c.req.json<RenameRequest>().catch(() => null);
    if (!body || typeof body.from !== 'string' || typeof body.to !== 'string') {
      throw badRequest('Corpo non valido: "from" e "to" sono obbligatori.');
    }
    const entriesBefore = await kb.tree(false);
    await pageRegistry.syncWithTree(entriesBefore, kb);
    const result = await kb.rename(body.from, body.to);
    await pageRegistry.onRename(result.from, result.to);
    return c.json(result);
  });

  app.post('/v1/files/archive', async (c) => {
    const body = await c.req.json<ArchiveRequest>().catch(() => null);
    if (!body || typeof body.path !== 'string') {
      throw badRequest('Corpo non valido: "path" obbligatorio.');
    }
    const result = await kb.archive(body.path);
    await pageRegistry.onDelete(result.from);
    await pageRegistry.purgeBrokenLinksAcrossKb(kb);
    return c.json(result);
  });

  app.delete('/v1/files/*', async (c) => {
    const rawPath = c.req.path.replace(/^\/v1\/files\//, '');
    const decoded = decodeURIComponent(rawPath);
    const result = await kb.delete(decoded);
    await pageRegistry.onDelete(result.path);
    await pageRegistry.purgeBrokenLinksAcrossKb(kb);
    return c.json(result);
  });

  // -------------------------------------------------------------------------
  // Allegati locali per copertine in kb/allegati/
  // -------------------------------------------------------------------------

  async function resolveSafeAttachmentAbs(relInput: string): Promise<{ rel: string; abs: string }> {
    const rel = normalizeRelPath(relInput, {
      kind: 'file',
      extensions: IMAGE_EXTENSIONS,
    });
    if (!rel.toLowerCase().startsWith(`${ATTACHMENTS_DIR}/`)) {
      throw invalidPath(`Gli allegati devono trovarsi in "${ATTACHMENTS_DIR}/".`);
    }
    const rootAbs = nodeResolve(config.kbDir);
    const targetAbs = nodeResolve(rootAbs, ...rel.split('/'));
    const normRoot = process.platform === 'win32' ? rootAbs.toLowerCase() : rootAbs;
    const normTarget = process.platform === 'win32' ? targetAbs.toLowerCase() : targetAbs;
    const sep = process.platform === 'win32' ? '\\' : '/';
    if (!normTarget.startsWith(normRoot.endsWith(sep) ? normRoot : normRoot + sep)) {
      throw forbidden('Percorso allegato fuori dalla knowledge base.');
    }
    return { rel, abs: targetAbs };
  }

  app.get('/v1/attachments', async (c) => {
    const dirAbs = nodeResolve(config.kbDir, ATTACHMENTS_DIR);
    if (!existsSync(dirAbs)) {
      const empty: AttachmentListResponse = { files: [] };
      return c.json(empty);
    }
    try {
      const dirents = await fs.readdir(dirAbs, { withFileTypes: true });
      const files = dirents
        .filter(
          (d) =>
            d.isFile() &&
            !d.isSymbolicLink() &&
            IMAGE_EXTENSIONS.includes(extOf(d.name)),
        )
        .map((d) => `${ATTACHMENTS_DIR}/${d.name}`)
        .sort();
      const res: AttachmentListResponse = { files };
      return c.json(res);
    } catch {
      return c.json({ files: [] });
    }
  });

  app.post('/v1/attachments', async (c) => {
    const body = await c.req.json<AttachmentUploadRequest>().catch(() => null);
    if (!body || typeof body.filename !== 'string' || typeof body.dataBase64 !== 'string') {
      throw badRequest('Corpo non valido: "filename" e "dataBase64" obbligatori.');
    }
    const ext = extOf(body.filename);
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      throw badRequest(`Formato immagine non supportato. Usa: ${IMAGE_EXTENSIONS.join(', ')}`);
    }
    const rawStem = body.filename.slice(0, -ext.length);
    const cleanStem = sanitizePageFileStem(rawStem) || 'copertina';
    const base64Clean = body.dataBase64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Clean, 'base64');
    if (buffer.byteLength === 0 || buffer.byteLength > 8 * 1024 * 1024) {
      throw badRequest('Dimensione immagine non valida (massimo 8 MB).');
    }

    let candidateRel = `${ATTACHMENTS_DIR}/${cleanStem}${ext}`;
    let counter = 2;
    while (existsSync(nodeResolve(config.kbDir, ...candidateRel.split('/')))) {
      candidateRel = `${ATTACHMENTS_DIR}/${cleanStem}-${counter}${ext}`;
      counter++;
    }

    const { rel, abs } = await resolveSafeAttachmentAbs(candidateRel);
    await fs.mkdir(nodeDirname(abs), { recursive: true });
    await fs.writeFile(abs, buffer);

    const res: AttachmentUploadResponse = { path: rel };
    return c.json(res);
  });

  app.get('/v1/attachments/raw', async (c) => {
    const pathParam = c.req.query('path');
    if (!pathParam) throw badRequest('Parametro "path" obbligatorio.');
    const { abs } = await resolveSafeAttachmentAbs(pathParam);
    if (!existsSync(abs)) {
      throw notFound('Allegato non trovato.');
    }
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw notFound('Allegato non valido.');
    const bytes = await fs.readFile(abs);
    const ext = extOf(pathParam);
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'private, max-age=3600',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  });

  // -------------------------------------------------------------------------
  // Storico e Ripristino
  // -------------------------------------------------------------------------

  app.get('/v1/files/history', async (c) => {
    const path = c.req.query('path');
    if (!path) throw badRequest('Parametro "path" obbligatorio.');
    const entries = await kb.historyList(path);
    const res: HistoryListResponse = { path, entries };
    return c.json(res);
  });

  app.get('/v1/files/history/version', async (c) => {
    const path = c.req.query('path');
    const id = c.req.query('id');
    if (!path || !id) throw badRequest('Parametri "path" e "id" obbligatori.');
    const content = await kb.historyGet(path, id);
    const res: HistoryVersionResponse = { path, id, content };
    return c.json(res);
  });

  app.post('/v1/files/history/restore', async (c) => {
    const body = await c.req.json<RestoreRequest>().catch(() => null);
    if (!body || typeof body.path !== 'string' || typeof body.id !== 'string') {
      throw badRequest('Corpo non valido: "path" e "id" sono obbligatori.');
    }
    const result = await kb.restore(body.path, body.id);
    pageRegistry.invalidateMeta(result.file.path);
    return c.json(result);
  });

  // -------------------------------------------------------------------------
  // Ricerca, Link e Tag
  // -------------------------------------------------------------------------

  app.get('/v1/search', async (c) => {
    const q = c.req.query('q');
    if (typeof q !== 'string') throw badRequest('Parametro "q" obbligatorio.');
    const limit = Number(c.req.query('limit')) || 200;
    const includeArchived = c.req.query('includeArchived') === 'true';
    const result = await kb.search(q, { limit, includeArchived });
    return c.json(result);
  });

  app.get('/v1/links', async (c) => {
    const path = c.req.query('path');
    if (!path) throw badRequest('Parametro "path" obbligatorio.');
    const entries = await kb.tree(false);
    const pages = await pageRegistry.syncWithTree(entries, kb);
    const result = await kb.linksOf(path);
    const resolvedOutgoing = result.outgoing
      .map((item) => {
        const resolvedPath =
          item.path ?? pageRegistry.resolveTargetToExistingPath(item.target, path, entries);
        if (!resolvedPath) return null;
        return {
          ...item,
          path: resolvedPath,
          status: 'ok' as const,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const backlinks = [...result.backlinks];
    const targetPage = pages.find((p) => p.path.toLowerCase() === path.toLowerCase());
    if (targetPage) {
      const needle = `page:${targetPage.id}`;
      const existingBacklinkKeys = new Set(backlinks.map((b) => `${b.path}:${b.line}`));
      for (const entry of entries) {
        if (
          entry.type !== 'file' ||
          entry.archived ||
          !entry.path.toLowerCase().endsWith('.md') ||
          entry.path.toLowerCase() === path.toLowerCase()
        ) {
          continue;
        }
        const file = await kb.read(entry.path).catch(() => null);
        if (!file || !file.content.includes(needle)) continue;
        const lines = file.content.replace(/\r\n/g, '\n').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i]!;
          if (ln.includes(`[[${needle}`)) {
            const key = `${entry.path}:${i + 1}`;
            if (!existingBacklinkKeys.has(key)) {
              existingBacklinkKeys.add(key);
              backlinks.push({
                path: entry.path,
                line: i + 1,
                context: ln.trim(),
              });
            }
          }
        }
      }
    }

    return c.json({
      ...result,
      outgoing: resolvedOutgoing,
      backlinks,
    });
  });

  app.get('/v1/tags', async (c) => {
    const tags = await kb.tags();
    const res: TagsResponse = { tags };
    return c.json(res);
  });

  // -------------------------------------------------------------------------
  // Vista (preferenze interfaccia)
  // -------------------------------------------------------------------------

  app.get('/v1/vista', async (c) => {
    const vista = await vistaStore.get();
    return c.json(vista);
  });

  app.put('/v1/vista', async (c) => {
    const patch = await c.req.json().catch(() => ({}));
    const updated = await vistaStore.update(patch);
    return c.json(updated);
  });

  // -------------------------------------------------------------------------
  // Metadati Link Esterni (Titolo pagina e Favicon per anteprima inline)
  // -------------------------------------------------------------------------

  const linkMetaCache = new Map<string, { title: string | null; favicon: string | null }>();

  function decodeHtmlEntities(str: string): string {
    return str
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&ndash;/gi, '–')
      .replace(/&mdash;/gi, '—')
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
        const cp = parseInt(hex, 16);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
      })
      .replace(/&#(\d+);/g, (_, dec) => {
        const cp = parseInt(dec, 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
      });
  }

  function isBlockedPrivateHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '0.0.0.0' ||
      h === '[::1]' ||
      h.endsWith('.local')
    ) {
      return true;
    }
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) {
      return true;
    }
    const m172 = h.match(/^172\.(\d+)\./);
    if (m172) {
      const second = Number(m172[1]);
      if (second >= 16 && second <= 31) return true;
    }
    return false;
  }

  app.get('/v1/link-meta', async (c) => {
    const rawUrl = c.req.query('url')?.trim() || '';
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return c.json({ title: null, favicon: null });
    }

    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      isBlockedPrivateHost(parsed.hostname)
    ) {
      return c.json({ title: null, favicon: null });
    }

    const cached = linkMetaCache.get(parsed.href);
    if (cached) {
      return c.json(cached);
    }

    try {
      let currentUrl = parsed;
      let res: Response | null = null;
      for (let hop = 0; hop <= 3; hop++) {
        if (
          (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') ||
          isBlockedPrivateHost(currentUrl.hostname)
        ) {
          return c.json({ title: null, favicon: null });
        }
        res = await fetch(currentUrl.href, {
          redirect: 'manual',
          signal: AbortSignal.timeout(3500),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BrainNotes/1.0',
            Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          },
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc || hop === 3) {
            return c.json({ title: null, favicon: null });
          }
          currentUrl = new URL(loc, currentUrl.href);
          continue;
        }
        break;
      }
      if (!res) {
        return c.json({ title: null, favicon: null });
      }

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !/text\/html|application\/xhtml/i.test(contentType) || !res.body) {
        const fallback = { title: null, favicon: `${currentUrl.origin}/favicon.ico` };
        linkMetaCache.set(parsed.href, fallback);
        return c.json(fallback);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let html = '';
      let bytesRead = 0;
      while (bytesRead < 65536) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        bytesRead += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (/<\/head>/i.test(html)) break;
      }
      await reader.cancel().catch(() => {});

      const ogMatch =
        html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
        html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i);
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const rawTitle = (ogMatch?.[1] || titleMatch?.[1] || '').replace(/\s+/g, ' ').trim();
      const cleanTitle = rawTitle ? decodeHtmlEntities(rawTitle).slice(0, 140) : null;

      const iconMatch =
        html.match(/<link[^>]+rel=["'](?:shortcut\s+icon|icon|apple-touch-icon)["'][^>]+href=["']([^"']+)["']/i) ||
        html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut\s+icon|icon|apple-touch-icon)["']/i);
      let faviconUrl = `${new URL(res.url || parsed.href).origin}/favicon.ico`;
      if (iconMatch?.[1]) {
        try {
          faviconUrl = new URL(decodeHtmlEntities(iconMatch[1].trim()), res.url || parsed.href).href;
        } catch {
          // mantieni /favicon.ico
        }
      }

      const meta = { title: cleanTitle, favicon: faviconUrl };
      linkMetaCache.set(parsed.href, meta);
      return c.json(meta);
    } catch {
      return c.json({ title: null, favicon: null });
    }
  });

  // -------------------------------------------------------------------------
  // Stato Agente (predisposto, non attivo)
  // -------------------------------------------------------------------------

  app.get('/v1/agent/status', (c) => {
    const res: AgentStatus = {
      configured: false,
      model: null,
      maxSteps: 0,
    };
    return c.json(res);
  });

  return app;
}
