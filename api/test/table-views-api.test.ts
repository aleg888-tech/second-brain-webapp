import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsHistoryStore, FsStorage, KbService } from '@brain/kb-core';
import type {
  AlignIdsResponse,
  CreateDatabaseResponse,
  CreateDatabaseRowResponse,
  SchemaOperationResponse,
  TableQueryResponse,
} from '@brain/shared';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

describe('API Database e Viste a Tabella (per-tabella)', () => {
  let rootDir: string;
  let kbDir: string;
  let kb: KbService;
  let token: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'brain-api-table-'));
    kbDir = join(rootDir, 'kb');
    const historyDir = join(rootDir, '.brain', 'history');
    await mkdir(kbDir, { recursive: true });
    await mkdir(historyDir, { recursive: true });
    token = 'test-secret-token-123';
    const config: AppConfig = {
      host: '127.0.0.1',
      port: 4310,
      webPort: 5173,
      projectRoot: rootDir,
      kbDir,
      historyDir,
      localJsonPath: join(rootDir, '.brain', 'local.json'),
      vistaJsonPath: join(rootDir, '.brain', 'vista.json'),
      extensions: ['.md'],
      exclude: ['_archivio', '.git'],
      agentDeny: ['AGENTS.md'],
      agentUrl: '',
      allowedOrigins: ['http://127.0.0.1:5173'],
    };
    kb = new KbService({
      storage: new FsStorage(kbDir),
      history: new FsHistoryStore(historyDir),
      extensions: config.extensions,
      exclude: config.exclude,
      agentDeny: config.agentDeny,
    });
    app = createApp({ config, kb, token });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function apiReq<T>(path: string, init?: RequestInit): Promise<{ status: number; data: T }> {
    const res = await app.request(`http://127.0.0.1:4310${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'http://127.0.0.1:5173',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }

  it('crea un database in una pagina foglia (convertendola in nodo), aggiunge righe e interroga la vista', async () => {
    await kb.create('progetti.md', '# Progetti\n\nTesto iniziale.\n');

    const createRes = await apiReq<CreateDatabaseResponse>('/v1/databases/create', {
      method: 'POST',
      body: JSON.stringify({
        hostPath: 'progetti.md',
        name: 'Attività programmate',
      }),
    });
    expect(createRes.status).toBe(200);
    expect(createRes.data.convertedHost?.from).toBe('progetti.md');
    expect(createRes.data.convertedHost?.to).toBe('progetti/_index.md');
    expect(createRes.data.databasePath).toBe('progetti/Attività programmate/_index.md');
    expect(createRes.data.databaseId).toMatch(/^p_[a-f0-9]+$/);
    expect(createRes.data.vistaBlock).toContain(`fonte: database ${createRes.data.databaseId}`);

    const dbId = createRes.data.databaseId;

    // Creazione riga con valori (nessuna colonna predefinita a meno del nome/titolo)
    const row1Res = await apiReq<CreateDatabaseRowResponse>(`/v1/databases/${dbId}/rows`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Consegna prototipo' }),
    });
    expect(row1Res.status).toBe(200);
    expect(row1Res.data.created.title).toBe('Consegna prototipo');
    expect(row1Res.data.created.content).toMatch(/creato: \d{4}-\d{2}-\d{2}/);

    // Query della vista: il database nasce senza colonne predefinite a meno del titolo/nome della nota
    const queryRes = await apiReq<TableQueryResponse>('/v1/views/query', {
      method: 'POST',
      body: JSON.stringify({
        vista: {
          fonte: `database ${dbId}`,
        },
      }),
    });
    expect(queryRes.status).toBe(200);
    expect(queryRes.data.schema.map((p) => p.chiave)).toEqual([]);
    expect(queryRes.data.totalRows).toBe(1);
    expect(queryRes.data.rows[0]?.title).toBe('Consegna prototipo');
  });

  it('gestisce operazioni sullo schema: rinomina senza toccare le righe, rinomina opzione con dryRun e snapshot, elimina proprietà preservando campi non definiti', async () => {
    await kb.create('home/_index.md', '# Home\n');
    const createRes = await apiReq<CreateDatabaseResponse>('/v1/databases/create', {
      method: 'POST',
      body: JSON.stringify({ hostPath: 'home/_index.md', name: 'Task' }),
    });
    const dbId = createRes.data.databaseId;
    const dbInitial = await apiReq<TableQueryResponse>(`/v1/databases/${dbId}`);
    let dbVersion = dbInitial.data.databaseVersion!;

    // Aggiungi proprietà "Persone" (selezione-multipla)
    const addProp = await apiReq<SchemaOperationResponse>(`/v1/databases/${dbId}/schema-op`, {
      method: 'POST',
      body: JSON.stringify({
        op: 'add-property',
        baseVersion: dbVersion,
        nome: 'Persone',
        tipo: 'selezione-multipla',
        opzioni: [
          { valore: 'Anna', colore: 'rosa' },
          { valore: 'Luca', colore: 'blu' },
        ],
      }),
    });
    expect(addProp.status).toBe(200);
    dbVersion = addProp.data.databaseVersion!;
    expect(addProp.data.schema.some((p) => p.chiave === 'persone')).toBe(true);

    // Crea riga con Persone: [Anna]
    const rowRes = await apiReq<CreateDatabaseRowResponse>(`/v1/databases/${dbId}/rows`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Analisi requisiti',
        initialValues: { persone: ['Anna'] },
      }),
    });
    const rowPath = rowRes.data.created.file.path;
    const rawRowBeforeRename = await readFile(join(kbDir, ...rowPath.split('/')), 'utf-8');

    // Rinomina proprietà "Persone" -> "Partecipanti": il file della riga resta identico byte per byte
    const renameProp = await apiReq<SchemaOperationResponse>(`/v1/databases/${dbId}/schema-op`, {
      method: 'POST',
      body: JSON.stringify({
        op: 'rename-property',
        baseVersion: dbVersion,
        chiave: 'persone',
        nuovoNome: 'Partecipanti',
      }),
    });
    expect(renameProp.status).toBe(200);
    dbVersion = renameProp.data.databaseVersion!;
    const rawRowAfterRename = await readFile(join(kbDir, ...rowPath.split('/')), 'utf-8');
    expect(rawRowAfterRename).toBe(rawRowBeforeRename);

    // Rinomina opzione "Anna" -> "Anna Maria": prima dryRun (anteprima), poi esecuzione con snapshot
    const renameOptDry = await apiReq<SchemaOperationResponse>(`/v1/databases/${dbId}/schema-op`, {
      method: 'POST',
      body: JSON.stringify({
        op: 'rename-option',
        baseVersion: dbVersion,
        chiave: 'persone',
        vecchioValore: 'Anna',
        nuovoValore: 'Anna Maria',
        dryRun: true,
      }),
    });
    expect(renameOptDry.status).toBe(200);
    expect(renameOptDry.data.dryRun).toBe(true);
    expect(renameOptDry.data.affectedCount).toBe(1);
    expect(renameOptDry.data.affectedPaths).toEqual([rowPath]);

    const renameOptApply = await apiReq<SchemaOperationResponse>(`/v1/databases/${dbId}/schema-op`, {
      method: 'POST',
      body: JSON.stringify({
        op: 'rename-option',
        baseVersion: dbVersion,
        chiave: 'persone',
        vecchioValore: 'Anna',
        nuovoValore: 'Anna Maria',
        dryRun: false,
      }),
    });
    expect(renameOptApply.status).toBe(200);
    dbVersion = renameOptApply.data.databaseVersion!;
    const updatedRow = await kb.read(rowPath);
    expect(updatedRow.content).toContain('Anna Maria');
    const rowHistory = await kb.historyList(rowPath);
    expect(rowHistory.length).toBeGreaterThanOrEqual(1);

    // Elimina proprietà "persone": i valori restano nel file e compaiono come undefinedFields
    const delDry = await apiReq<SchemaOperationResponse>(`/v1/databases/${dbId}/schema-op`, {
      method: 'POST',
      body: JSON.stringify({
        op: 'delete-property',
        baseVersion: dbVersion,
        chiave: 'persone',
        dryRun: true,
      }),
    });
    expect(delDry.data.affectedCount).toBe(1);

    const delApply = await apiReq<SchemaOperationResponse>(`/v1/databases/${dbId}/schema-op`, {
      method: 'POST',
      body: JSON.stringify({
        op: 'delete-property',
        baseVersion: dbVersion,
        chiave: 'persone',
        dryRun: false,
      }),
    });
    dbVersion = delApply.data.databaseVersion!;

    const afterDelQuery = await apiReq<TableQueryResponse>(`/v1/databases/${dbId}`);
    expect(afterDelQuery.data.undefinedFields).toEqual([
      {
        chiave: 'persone',
        count: 1,
        sampleValues: [['Anna Maria']],
        inferredType: 'selezione-multipla',
      },
    ]);

    // Ripristina campo non definito con la stessa chiave
    const restoreProp = await apiReq<SchemaOperationResponse>(`/v1/databases/${dbId}/schema-op`, {
      method: 'POST',
      body: JSON.stringify({
        op: 'restore-undefined',
        baseVersion: dbVersion,
        chiave: 'persone',
        nome: 'Persone',
        tipo: 'selezione-multipla',
      }),
    });
    expect(restoreProp.status).toBe(200);
    expect(restoreProp.data.schema.some((p) => p.chiave === 'persone')).toBe(true);
  });

  it('rispetta la precedenza proprieta vista > schema database > inferenza e gestisce allinea-id', async () => {
    // Crea una pagina manualmente senza id nel frontmatter
    await writeFile(
      join(kbDir, 'nota-libera.md'),
      '---\npriorita: 5\nscadenza: 2026-09-01\n---\n# Nota libera\n',
      'utf-8',
    );

    // Allinea ID: dryRun=true non modifica il file
    const alignPreview = await apiReq<AlignIdsResponse>('/v1/pages/align-ids', {
      method: 'POST',
      body: JSON.stringify({ dryRun: true }),
    });
    expect(alignPreview.status).toBe(200);
    expect(alignPreview.data.count).toBe(1);
    expect(alignPreview.data.paths).toEqual(['nota-libera.md']);

    // Allinea ID: dryRun=false scrive id: p_... con snapshot
    const alignApply = await apiReq<AlignIdsResponse>('/v1/pages/align-ids', {
      method: 'POST',
      body: JSON.stringify({ dryRun: false }),
    });
    expect(alignApply.status).toBe(200);
    expect(alignApply.data.modified).toHaveLength(1);
    const alignedContent = await readFile(join(kbDir, 'nota-libera.md'), 'utf-8');
    expect(alignedContent).toMatch(/^---\nid: p_[a-f0-9]+\n/);

    // Query su "tutte" con inferenza e override nel blocco vista
    const queryTutte = await apiReq<TableQueryResponse>('/v1/views/query', {
      method: 'POST',
      body: JSON.stringify({
        vista: {
          fonte: 'tutte',
          colonne: ['titolo', 'priorita', 'scadenza', 'colonna_inesistente'],
          proprieta: [
            { chiave: 'priorita', nome: 'Priorità Custom', tipo: 'numero', decimali: 2 },
          ],
        },
      }),
    });
    expect(queryTutte.status).toBe(200);
    expect(queryTutte.data.missingProperties).toEqual(['colonna_inesistente']);
    const prioCol = queryTutte.data.effectiveColumns.find((c) => c.chiave === 'priorita');
    const scadCol = queryTutte.data.effectiveColumns.find((c) => c.chiave === 'scadenza');
    expect(prioCol?.nome).toBe('Priorità Custom');
    expect(prioCol?.decimali).toBe(2);
    expect(scadCol?.tipo).toBe('data');

    // Verifica che non esista alcun catalogo globale .brain/page-props.json
    expect(existsSync(join(rootDir, '.brain', 'page-props.json'))).toBe(false);
  });
});
