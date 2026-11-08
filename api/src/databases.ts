import {
  addPropertyToSchema,
  ATTACHMENTS_DIR,
  attachValidationWarningsToRows,
  badRequest,
  buildOptionsFromExistingValues,
  changePropertyTypeInSchema,
  createDefaultDatabaseSchema,
  deletePropertyFromSchema,
  detectUndefinedFields,
  filterTableRows,
  isRowValueEmpty,
  localDate,
  notFound,
  parseFrontmatterYaml,
  parsePropertyDefinitions,
  parseVistaSource,
  patchFrontmatterField,
  planOptionRenameMigration,
  renamePropertyInSchema,
  reorderPropertiesInSchema,
  resolveEffectiveColumns,
  restoreUndefinedPropertyToSchema,
  SCHEMA_VERSION,
  serializePropertyDefinitions,
  serializeVistaBlock,
  setPropertyDecimalsInSchema,
  setPropertyDefaultInSchema,
  sortTableRows,
  updatePropertyOptionsInSchema,
  type KbService,
} from '@brain/kb-core';
import type {
  CreateDatabaseRequest,
  CreateDatabaseResponse,
  CreateDatabaseRowRequest,
  CreateDatabaseRowResponse,
  PageIdentity,
  PropertyDefinition,
  SchemaOperationRequest,
  SchemaOperationResponse,
  TableQueryRequest,
  TableQueryResponse,
  TableRowItem,
  TreeEntry,
} from '@brain/shared';
import type { PageRegistry } from './pages.js';

function sanitizeFileStem(raw: string): string {
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

function pageDisplayName(openPath: string): string {
  const clean = openPath.replace(/^\/+|\/+$/g, '');
  if (clean.toLowerCase() === '_index.md') return 'Home';
  if (clean.toLowerCase().endsWith('/_index.md')) {
    const dir = clean.slice(0, -'/_index.md'.length);
    const slash = dir.lastIndexOf('/');
    return slash === -1 ? dir : dir.slice(slash + 1);
  }
  const slash = clean.lastIndexOf('/');
  const base = slash === -1 ? clean : clean.slice(slash + 1);
  return base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base;
}

function parentDirOfOpenPath(openPath: string): string {
  const clean = openPath.replace(/^\/+|\/+$/g, '');
  if (clean.toLowerCase() === '_index.md') return '';
  if (clean.toLowerCase().endsWith('/_index.md')) {
    const nodeDir = clean.slice(0, -'/_index.md'.length);
    const slash = nodeDir.lastIndexOf('/');
    return slash === -1 ? '' : nodeDir.slice(0, slash);
  }
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? '' : clean.slice(0, slash);
}

function nodeDirOfOpenPath(openPath: string): string | null {
  const clean = openPath.replace(/^\/+|\/+$/g, '');
  if (clean.toLowerCase() === '_index.md') return '';
  if (clean.toLowerCase().endsWith('/_index.md')) {
    return clean.slice(0, -'/_index.md'.length);
  }
  return null;
}

function pickUniqueFolderPath(
  parentDir: string,
  desiredName: string,
  entries: readonly TreeEntry[],
): { dirPath: string; displayName: string } {
  const cleanParent = parentDir.replace(/^\/+|\/+$/g, '');
  const prefix = cleanParent ? `${cleanParent}/` : '';
  const baseName = sanitizeFileStem(desiredName) || 'Nuovo database';
  const occupiedLower = new Set<string>();
  for (const e of entries) {
    if (e.archived) continue;
    occupiedLower.add(e.path.toLowerCase());
  }
  let candidate = baseName;
  let counter = 2;
  while (
    occupiedLower.has(`${prefix}${candidate}`.toLowerCase()) ||
    occupiedLower.has(`${prefix}${candidate}.md`.toLowerCase()) ||
    occupiedLower.has(`${prefix}${candidate}/_index.md`.toLowerCase())
  ) {
    candidate = `${baseName} ${counter}`;
    counter++;
  }
  return {
    dirPath: `${prefix}${candidate}`,
    displayName: candidate,
  };
}

function pickUniqueChildPagePath(
  parentDir: string,
  desiredTitle: string | undefined,
  entries: readonly TreeEntry[],
): { filePath: string; title: string } {
  const cleanParent = parentDir.replace(/^\/+|\/+$/g, '');
  const prefix = cleanParent ? `${cleanParent}/` : '';
  const baseTitle = sanitizeFileStem(desiredTitle ?? '') || 'Nuova riga';
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
  return {
    filePath: `${prefix}${candidateStem}.md`,
    title: candidateStem,
  };
}

/**
 * Individua le pagine logiche (foglie `nome.md` o nodi `nome/_index.md`) presenti nell'albero attivo.
 */
function collectLogicalPages(
  entries: readonly TreeEntry[],
  pages: readonly PageIdentity[],
): Array<{
  openPath: string;
  managePath: string;
  parentDir: string;
  isNode: boolean;
  entry: TreeEntry;
  pageId: string;
  tipo: string | null;
}> {
  const pageByLower = new Map<string, PageIdentity>();
  for (const p of pages) {
    pageByLower.set(p.path.toLowerCase(), p);
  }

  const activeFiles = entries.filter(
    (e) =>
      e.type === 'file' &&
      !e.archived &&
      e.path.toLowerCase().endsWith('.md') &&
      e.path.toLowerCase() !== 'agents.md' &&
      !e.path.toLowerCase().startsWith(`${ATTACHMENTS_DIR}/`),
  );

  const fileByLower = new Map<string, TreeEntry>();
  for (const f of activeFiles) {
    fileByLower.set(f.path.toLowerCase(), f);
  }

  const out: Array<{
    openPath: string;
    managePath: string;
    parentDir: string;
    isNode: boolean;
    entry: TreeEntry;
    pageId: string;
    tipo: string | null;
  }> = [];

  for (const f of activeFiles) {
    const low = f.path.toLowerCase();
    if (low === '_index.md') continue;
    const isNode = low.endsWith('/_index.md');
    const managePath = isNode ? f.path.slice(0, -'/_index.md'.length) : f.path;
    const parentDir = parentDirOfOpenPath(f.path);
    const meta = pageByLower.get(low);
    out.push({
      openPath: f.path,
      managePath,
      parentDir,
      isNode,
      entry: f,
      pageId: meta?.id ?? f.path,
      tipo: meta?.tipo ?? null,
    });
  }

  // Cartelle con figli ma prive di _index.md fisico
  for (const d of entries) {
    if (d.type !== 'dir' || d.archived || d.path.toLowerCase().startsWith(`${ATTACHMENTS_DIR}/`)) {
      continue;
    }
    const idxPath = `${d.path}/_index.md`;
    if (fileByLower.has(idxPath.toLowerCase())) continue;
    const slash = d.path.lastIndexOf('/');
    const parentDir = slash === -1 ? '' : d.path.slice(0, slash);
    const meta = pageByLower.get(idxPath.toLowerCase());
    out.push({
      openPath: idxPath,
      managePath: d.path,
      parentDir,
      isNode: true,
      entry: d,
      pageId: meta?.id ?? idxPath,
      tipo: meta?.tipo ?? null,
    });
  }

  return out;
}

export async function createDatabaseInPage(
  kb: KbService,
  pageRegistry: PageRegistry,
  req: CreateDatabaseRequest,
): Promise<CreateDatabaseResponse> {
  const entriesBefore = await kb.tree(false);
  await pageRegistry.syncWithTree(entriesBefore, kb);

  let convertedHost: CreateDatabaseResponse['convertedHost'];
  let hostDir = '';
  const trimmedHost = (req.hostPath ?? '').trim();

  if (trimmedHost === '' || trimmedHost.toLowerCase() === '_index.md') {
    hostDir = '';
  } else if (trimmedHost.toLowerCase().endsWith('/_index.md')) {
    hostDir = kb.dirPath(trimmedHost.slice(0, -'/_index.md'.length));
    const dirExists = entriesBefore.some(
      (e) => e.type === 'dir' && e.path.toLowerCase() === hostDir.toLowerCase(),
    );
    if (!dirExists) {
      await kb.createDir(hostDir);
    }
  } else if (trimmedHost.toLowerCase().endsWith('.md')) {
    const conv = await kb.convertLeafToNode(trimmedHost);
    await pageRegistry.onRename(conv.from, conv.to);
    convertedHost = {
      from: conv.from,
      to: conv.to,
      historyId: conv.historyId,
    };
    hostDir = conv.to.slice(0, -'/_index.md'.length);
  } else {
    hostDir = kb.dirPath(trimmedHost);
  }

  const entriesNow = await kb.tree(false);
  const { dirPath: dbDirPath, displayName } = pickUniqueFolderPath(
    hostDir,
    req.name?.trim() || 'Nuovo database',
    entriesNow,
  );
  const dbIndexPath = `${dbDirPath}/_index.md`;
  const dbPage = await pageRegistry.ensurePage(dbIndexPath);
  const initialSchema = createDefaultDatabaseSchema();

  let dbContent = '';
  dbContent = patchFrontmatterField(dbContent, 'id', dbPage.id, { insertAtTop: true });
  dbContent = patchFrontmatterField(dbContent, 'tipo', 'database');
  dbContent = patchFrontmatterField(dbContent, 'versione-schema', SCHEMA_VERSION);
  dbContent = patchFrontmatterField(
    dbContent,
    'proprieta',
    serializePropertyDefinitions(initialSchema),
  );

  await kb.create(dbIndexPath, dbContent);
  pageRegistry.invalidateMeta(dbIndexPath);
  const finalEntries = await kb.tree(false);
  await pageRegistry.syncWithTree(finalEntries, kb);

  const vistaBlock = serializeVistaBlock({
    fonte: `database ${dbPage.id}`,
    colonne: initialSchema.map((p) => p.chiave),
  });

  return {
    ...(convertedHost ? { convertedHost } : {}),
    databaseId: dbPage.id,
    databasePath: dbIndexPath,
    databaseName: displayName,
    vistaBlock,
  };
}

export async function findDatabaseById(
  kb: KbService,
  pageRegistry: PageRegistry,
  databaseId: string,
): Promise<{
  page: PageIdentity;
  dbIndexPath: string;
  dbDirPath: string;
  version: string;
  content: string;
  schema: PropertyDefinition[];
} | null> {
  const entries = await kb.tree(false);
  const pages = await pageRegistry.syncWithTree(entries, kb);
  const cleanId = databaseId.trim();

  const match = pages.find((p) => p.id === cleanId);
  if (!match || !match.path.toLowerCase().endsWith('/_index.md')) {
    return null;
  }

  const file = await kb.read(match.path).catch(() => null);
  if (!file) return null;
  const parsed = parseFrontmatterYaml(file.content);
  if (parsed.data.tipo !== 'database') {
    return null;
  }

  const schema = parsePropertyDefinitions(parsed.data.proprieta);
  const dbDirPath = match.path.slice(0, -'/_index.md'.length);

  return {
    page: match,
    dbIndexPath: match.path,
    dbDirPath,
    version: file.version,
    content: file.content,
    schema,
  };
}

export async function queryTableView(
  kb: KbService,
  pageRegistry: PageRegistry,
  req: TableQueryRequest,
): Promise<TableQueryResponse> {
  const entries = await kb.tree(false);
  const pages = await pageRegistry.syncWithTree(entries, kb);
  const vista = req.vista;
  const parsedSource = parseVistaSource(vista?.fonte);

  if (!parsedSource) {
    return {
      sourceType: 'tutte',
      schema: [],
      effectiveColumns: [],
      rows: [],
      totalRows: 0,
      undefinedFields: [],
      missingProperties: [],
      canAddRow: false,
      canEditSchema: false,
      error:
        'Fonte della vista non valida. Usa "database p_...", "sottopagine", "discendenti" o "tutte".',
    };
  }

  let dbInfo: Awaited<ReturnType<typeof findDatabaseById>> = null;
  let schemaDbInfo: Awaited<ReturnType<typeof findDatabaseById>> = null;

  if (parsedSource.type === 'database' && parsedSource.targetId) {
    dbInfo = await findDatabaseById(kb, pageRegistry, parsedSource.targetId);
    if (!dbInfo) {
      return {
        sourceType: 'database',
        databaseId: parsedSource.targetId,
        schema: [],
        effectiveColumns: [],
        rows: [],
        totalRows: 0,
        undefinedFields: [],
        missingProperties: [],
        canAddRow: false,
        canEditSchema: false,
        error: `Database non trovato (${parsedSource.targetId}).`,
      };
    }
  }

  if (vista.schema) {
    schemaDbInfo = await findDatabaseById(kb, pageRegistry, vista.schema);
    if (!schemaDbInfo) {
      return {
        sourceType: parsedSource.type,
        databaseId: dbInfo?.page.id ?? null,
        schema: [],
        effectiveColumns: [],
        rows: [],
        totalRows: 0,
        undefinedFields: [],
        missingProperties: [],
        canAddRow: false,
        canEditSchema: false,
        error: `Database schema "${vista.schema}" non trovato.`,
      };
    }
  }

  const allLogical = collectLogicalPages(entries, pages);
  let selectedPages: typeof allLogical = [];

  if (parsedSource.type === 'database' && dbInfo) {
    const targetDirLower = dbInfo.dbDirPath.toLowerCase();
    selectedPages = allLogical.filter(
      (p) =>
        p.parentDir.toLowerCase() === targetDirLower &&
        p.openPath.toLowerCase() !== dbInfo!.dbIndexPath.toLowerCase(),
    );
  } else if (parsedSource.type === 'sottopagine') {
    const hostPath = (req.hostPath ?? '_index.md').trim();
    const hostNodeDir = nodeDirOfOpenPath(hostPath);
    if (hostNodeDir === null) {
      // Una pagina foglia senza cartella non ha ancora sottopagine
      selectedPages = [];
    } else {
      const dirLower = hostNodeDir.toLowerCase();
      selectedPages = allLogical.filter(
        (p) => p.parentDir.toLowerCase() === dirLower && p.tipo !== 'database',
      );
    }
  } else if (parsedSource.type === 'discendenti') {
    let baseDir: string | null = null;
    if (parsedSource.targetId) {
      const targetPage = pages.find((p) => p.id === parsedSource.targetId);
      if (!targetPage) {
        return {
          sourceType: 'discendenti',
          schema: [],
          effectiveColumns: [],
          rows: [],
          totalRows: 0,
          undefinedFields: [],
          missingProperties: [],
          canAddRow: false,
          canEditSchema: false,
          error: `Pagina radice "${parsedSource.targetId}" non trovata.`,
        };
      }
      baseDir = nodeDirOfOpenPath(targetPage.path);
    } else {
      baseDir = nodeDirOfOpenPath((req.hostPath ?? '_index.md').trim());
    }
    if (baseDir === null) {
      selectedPages = [];
    } else if (baseDir === '') {
      selectedPages = allLogical.filter((p) => p.tipo !== 'database');
    } else {
      const prefixLower = `${baseDir.toLowerCase()}/`;
      selectedPages = allLogical.filter(
        (p) =>
          (p.parentDir.toLowerCase() === baseDir!.toLowerCase() ||
            p.parentDir.toLowerCase().startsWith(prefixLower)) &&
          p.tipo !== 'database',
      );
    }
  } else {
    // fonte: "tutte"
    selectedPages = allLogical.filter((p) => p.tipo !== 'database');
  }

  const rawRows: TableRowItem[] = [];
  for (const item of selectedPages) {
    const indexed = kb.frontmatter.get(item.openPath);
    const fileDoc = await kb.readOrVirtualIndex(item.openPath).catch(() => null);
    const fmData = indexed?.data ?? (fileDoc ? parseFrontmatterYaml(fileDoc.content).data : {});
    const tags = indexed?.tags ?? [];
    const mtimeMs = fileDoc?.mtimeMs ?? item.entry.mtimeMs ?? Date.now();
    const modificato = localDate(new Date(mtimeMs));
    const creato =
      typeof fmData.creato === 'string' && fmData.creato.trim()
        ? fmData.creato.trim()
        : typeof fmData['creato-il'] === 'string' && fmData['creato-il'].trim()
          ? fmData['creato-il'].trim()
          : null;

    rawRows.push({
      path: item.openPath,
      managePath: item.managePath,
      pageId: item.pageId,
      title: pageDisplayName(item.openPath),
      isNode: item.isNode,
      version: fileDoc?.version ?? '',
      mtimeMs,
      creato,
      modificato,
      percorso: item.managePath,
      tag: tags,
      values: { ...fmData },
      warnings: {},
    });
  }

  const inheritedDbSchema = schemaDbInfo?.schema ?? dbInfo?.schema ?? [];
  const activeSchema =
    vista.proprieta && vista.proprieta.length > 0 ? vista.proprieta : inheritedDbSchema;

  const { effectiveColumns, allDefinitionsByKey, missingProperties } = resolveEffectiveColumns(
    vista,
    inheritedDbSchema,
    rawRows,
    parsedSource.type,
  );

  const rowsWithWarnings = attachValidationWarningsToRows(rawRows, allDefinitionsByKey);
  const undefinedFields = detectUndefinedFields(rowsWithWarnings, activeSchema);
  const filteredRows = filterTableRows(rowsWithWarnings, vista.filtri);
  const sortedRows = sortTableRows(filteredRows, vista.ordina, allDefinitionsByKey);

  return {
    sourceType: parsedSource.type,
    databaseId: dbInfo?.page.id ?? schemaDbInfo?.page.id ?? null,
    databasePath: dbInfo?.dbIndexPath ?? null,
    databaseVersion: dbInfo?.version ?? null,
    databaseName: dbInfo ? pageDisplayName(dbInfo.dbIndexPath) : null,
    hostPath: req.hostPath,
    schema: activeSchema,
    effectiveColumns,
    rows: sortedRows,
    totalRows: sortedRows.length,
    undefinedFields,
    missingProperties,
    canAddRow: parsedSource.type === 'database' || parsedSource.type === 'sottopagine',
    canEditSchema: true,
    error: null,
  };
}

export async function executeDatabaseSchemaOperation(
  kb: KbService,
  pageRegistry: PageRegistry,
  databaseId: string,
  req: SchemaOperationRequest,
): Promise<SchemaOperationResponse> {
  const dbInfo = await findDatabaseById(kb, pageRegistry, databaseId);
  if (!dbInfo) {
    throw notFound(`Database "${databaseId}" non trovato.`);
  }

  const baseVersion = req.baseVersion ?? dbInfo.version;
  const currentSchema = dbInfo.schema;

  // Raccoglie le righe dirette del database quando l'operazione richiede ispezione/migrazione valori
  const loadDirectDatabaseRows = async () => {
    const entries = await kb.tree(false);
    const pages = await pageRegistry.syncWithTree(entries, kb);
    const allLogical = collectLogicalPages(entries, pages);
    const targetDirLower = dbInfo.dbDirPath.toLowerCase();
    const direct = allLogical.filter(
      (p) =>
        p.parentDir.toLowerCase() === targetDirLower &&
        p.openPath.toLowerCase() !== dbInfo.dbIndexPath.toLowerCase(),
    );
    const loaded: Array<{
      path: string;
      version: string;
      content: string;
      values: Record<string, unknown>;
    }> = [];
    for (const item of direct) {
      const f = await kb.read(item.openPath).catch(() => null);
      if (!f) continue;
      const parsed = parseFrontmatterYaml(f.content);
      loaded.push({
        path: item.openPath,
        version: f.version,
        content: f.content,
        values: parsed.data,
      });
    }
    return loaded;
  };

  let nextSchema: PropertyDefinition[] = currentSchema;
  let createdProperty: PropertyDefinition | undefined;

  switch (req.op) {
    case 'add-property': {
      const res = addPropertyToSchema(currentSchema, {
        nome: req.nome,
        tipo: req.tipo,
        opzioni: req.opzioni,
        predefinito: req.predefinito,
        decimali: req.decimali,
      });
      nextSchema = res.schema;
      createdProperty = res.created;
      break;
    }

    case 'rename-property': {
      nextSchema = renamePropertyInSchema(currentSchema, req.chiave, req.nuovoNome);
      break;
    }

    case 'change-type': {
      nextSchema = changePropertyTypeInSchema(currentSchema, req.chiave, req.nuovoTipo);
      break;
    }

    case 'create-options-from-values': {
      const rows = await loadDirectDatabaseRows();
      const targetTipo = req.targetTipo ?? 'seleziona';
      const existingProp = currentSchema.find((p) => p.chiave === req.chiave);
      if (!existingProp) {
        throw badRequest(`Proprietà "${req.chiave}" non trovata.`);
      }
      const generated = buildOptionsFromExistingValues(
        rows.map((r) => r.values[req.chiave]),
        targetTipo,
        existingProp.opzioni ?? [],
      );
      if (req.dryRun) {
        return {
          dryRun: true,
          schema: currentSchema,
          databaseVersion: dbInfo.version,
          generatedOptions: generated,
          affectedCount: generated.length,
        };
      }
      const typedSchema = changePropertyTypeInSchema(currentSchema, req.chiave, targetTipo);
      nextSchema = updatePropertyOptionsInSchema(typedSchema, req.chiave, generated);
      break;
    }

    case 'update-options': {
      nextSchema = updatePropertyOptionsInSchema(currentSchema, req.chiave, req.opzioni);
      break;
    }

    case 'rename-option': {
      const rows = await loadDirectDatabaseRows();
      const plan = planOptionRenameMigration(
        currentSchema,
        rows,
        req.chiave,
        req.vecchioValore,
        req.nuovoValore,
      );
      if (req.dryRun) {
        return {
          dryRun: true,
          schema: currentSchema,
          databaseVersion: dbInfo.version,
          affectedCount: plan.affectedRows.length,
          affectedPaths: plan.affectedRows.map((r) => r.path),
        };
      }
      // Patch dello schema + patch chirurgica (con snapshot nello storico!) delle sole pagine interessate
      const patchedDb = await kb.patchFrontmatter(
        dbInfo.dbIndexPath,
        'proprieta',
        serializePropertyDefinitions(plan.updatedSchema),
        baseVersion,
      );
      pageRegistry.invalidateMeta(dbInfo.dbIndexPath);

      for (const target of plan.affectedRows) {
        const curRow = rows.find((r) => r.path === target.path);
        if (!curRow) continue;
        await kb.patchFrontmatter(
          target.path,
          req.chiave,
          target.nextValue,
          curRow.version,
        );
        pageRegistry.invalidateMeta(target.path);
      }

      return {
        dryRun: false,
        schema: plan.updatedSchema,
        databaseVersion: patchedDb.file.version,
        historyId: patchedDb.historyId,
        affectedCount: plan.affectedRows.length,
        affectedPaths: plan.affectedRows.map((r) => r.path),
      };
    }

    case 'set-default': {
      nextSchema = setPropertyDefaultInSchema(currentSchema, req.chiave, req.predefinito);
      break;
    }

    case 'set-decimals': {
      nextSchema = setPropertyDecimalsInSchema(currentSchema, req.chiave, req.decimali);
      break;
    }

    case 'reorder-properties': {
      nextSchema = reorderPropertiesInSchema(currentSchema, req.orderedKeys);
      break;
    }

    case 'delete-property': {
      const rows = await loadDirectDatabaseRows();
      const rowsWithVal = rows.filter((r) => !isRowValueEmpty(r.values[req.chiave]));
      if (req.dryRun) {
        return {
          dryRun: true,
          schema: currentSchema,
          databaseVersion: dbInfo.version,
          affectedCount: rowsWithVal.length,
          affectedPaths: rowsWithVal.map((r) => r.path),
        };
      }
      nextSchema = deletePropertyFromSchema(currentSchema, req.chiave);
      break;
    }

    case 'restore-undefined': {
      nextSchema = restoreUndefinedPropertyToSchema(currentSchema, {
        chiave: req.chiave,
        nome: req.nome,
        tipo: req.tipo,
        opzioni: req.opzioni,
      });
      break;
    }
  }

  const patched = await kb.patchFrontmatter(
    dbInfo.dbIndexPath,
    'proprieta',
    serializePropertyDefinitions(nextSchema),
    baseVersion,
  );
  pageRegistry.invalidateMeta(dbInfo.dbIndexPath);

  return {
    dryRun: false,
    schema: nextSchema,
    databaseVersion: patched.file.version,
    historyId: patched.historyId,
    ...(createdProperty ? { createdProperty } : {}),
  };
}

export async function createDatabaseRow(
  kb: KbService,
  pageRegistry: PageRegistry,
  databaseId: string,
  req: CreateDatabaseRowRequest,
): Promise<CreateDatabaseRowResponse> {
  const dbInfo = await findDatabaseById(kb, pageRegistry, databaseId);
  if (!dbInfo) {
    throw notFound(`Database "${databaseId}" non trovato.`);
  }

  const entries = await kb.tree(false);
  const { filePath, title } = pickUniqueChildPagePath(
    dbInfo.dbDirPath,
    req.title,
    entries,
  );
  const rowPage = await pageRegistry.ensurePage(filePath);
  const todayIso = localDate(new Date());

  let rowContent = '';
  rowContent = patchFrontmatterField(rowContent, 'id', rowPage.id, { insertAtTop: true });
  rowContent = patchFrontmatterField(rowContent, 'creato', todayIso);

  // Applica i valori predefiniti dello schema + eventuali initialValues
  for (const prop of dbInfo.schema) {
    const val =
      req.initialValues && req.initialValues[prop.chiave] !== undefined
        ? req.initialValues[prop.chiave]
        : prop.predefinito;
    if (val !== undefined && val !== null && val !== '') {
      rowContent = patchFrontmatterField(rowContent, prop.chiave, val);
    }
  }

  const created = await kb.create(filePath, rowContent);
  pageRegistry.invalidateMeta(created.file.path);
  const freshEntries = await kb.tree(false);
  await pageRegistry.syncWithTree(freshEntries, kb);

  return {
    created: {
      ...created,
      pageId: rowPage.id,
      title,
      content: rowContent,
    },
  };
}
