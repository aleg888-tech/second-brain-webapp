import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsHistoryStore, FsStorage, KbService } from '@brain/kb-core';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

async function readJson(res: Promise<Response> | Response): Promise<any> {
  const r = await res;
  return r.json();
}

describe('Fase 1 API — Pagine-nodo, conversione, link immutabili, storico su purge e allegati', () => {
  const tempDirs: string[] = [];
  const token = 'phase1-test-token-123456';
  const headers = {
    host: '127.0.0.1:4310',
    authorization: `Bearer ${token}`,
  };

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  async function setupTestApp() {
    const root = await mkdtemp(path.join(tmpdir(), 'brain-api-p1-'));
    tempDirs.push(root);
    const kbDir = path.join(root, 'kb');
    const historyDir = path.join(root, '.brain', 'history');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(kbDir, { recursive: true });
    await mkdir(historyDir, { recursive: true });

    const config: AppConfig = {
      projectRoot: root,
      kbDir,
      historyDir,
      localJsonPath: path.join(root, '.brain', 'local.json'),
      vistaJsonPath: path.join(root, '.brain', 'vista.json'),
      port: 4310,
      host: '127.0.0.1',
      webPort: 5173,
      allowedOrigins: ['http://127.0.0.1:5173'],
      extensions: ['.md', '.csv', '.txt'],
      exclude: ['_archivio', '.git'],
      agentDeny: [],
      agentUrl: '',
    };

    const kb = new KbService({
      storage: new FsStorage(kbDir),
      history: new FsHistoryStore(historyDir),
      extensions: config.extensions,
      exclude: config.exclude,
      agentDeny: config.agentDeny,
    });

    const app = createApp({ config, kb, token });
    return { app, kb, root, kbDir };
  }

  it('converte foglia -> nodo su "Aggiungi sottopagina" mantenendo immutabili pageId, link [[page:p_...]] e storico', async () => {
    const { app } = await setupTestApp();

    // 1. Crea foglia `Progetto.md` e aggiunge una versione nello storico
    const c1 = await readJson(
      app.request('/v1/files/create', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'Progetto.md', content: 'Versione 1\n' }),
      }),
    );
    const projectPageId = c1.pageId as string;
    expect(projectPageId).toMatch(/^p_/);

    await app.request('/v1/files/content', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: 'Progetto.md',
        content: 'Versione 2 prima di diventare nodo\n',
        baseVersion: c1.file.version,
      }),
    });

    // 2. Crea Home con un link per id verso `Progetto.md`
    await app.request('/v1/files/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: '_index.md',
        content: `Collegamento al progetto: [[page:${projectPageId}]]\n`,
      }),
    });

    // 3. "Aggiungi sottopagina" su `Progetto.md`: converte atomicamente in `Progetto/_index.md`
    const subRes = await app.request('/v1/pages/create-subpage', {
      method: 'POST',
      headers,
      body: JSON.stringify({ parentPath: 'Progetto.md', title: 'Fase A' }),
    });
    expect(subRes.status).toBe(200);
    const subJson = await readJson(subRes);
    expect(subJson.convertedParent).toMatchObject({
      from: 'Progetto.md',
      to: 'Progetto/_index.md',
    });
    expect(subJson.created.file.path).toBe('Progetto/Fase A.md');

    // 4. Il pageId è immutabile e il link [[page:p_...]] nella Home resta valido senza cambiare
    const homeRead = await readJson(
      app.request('/v1/files/content?path=_index.md', { headers }),
    );
    expect(homeRead.content).toContain(`Collegamento al progetto: [[page:${projectPageId}]]\n`);
    expect(homeRead.content).toMatch(/^---\nid: p_[a-zA-Z0-9_-]+\n---\n/);

    const linksAfterConv = await readJson(
      app.request('/v1/links?path=_index.md', { headers }),
    );
    expect(linksAfterConv.outgoing).toHaveLength(1);
    expect(linksAfterConv.outgoing[0].path).toBe('Progetto/_index.md');
    expect(linksAfterConv.outgoing[0].status).toBe('ok');

    // 5. Lo storico ha seguito la pagina in `Progetto/_index.md`
    const histAfterConv = await readJson(
      app.request(
        `/v1/files/history?path=${encodeURIComponent('Progetto/_index.md')}`,
        { headers },
      ),
    );
    expect(histAfterConv.entries.length).toBeGreaterThanOrEqual(2);

    // 6. Rinomina la pagina-nodo (`Progetto` -> `Progetto 2027`): cartella rinominata, pageId e link invariati
    const renRes = await app.request('/v1/files/rename', {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: 'Progetto/_index.md', to: 'Progetto 2027' }),
    });
    expect(renRes.status).toBe(200);
    const renJson = await readJson(renRes);
    expect(renJson).toEqual({ from: 'Progetto', to: 'Progetto 2027' });

    const treeJson = await readJson(app.request('/v1/tree', { headers }));
    const movedPage = treeJson.pages.find((p: any) => p.id === projectPageId);
    expect(movedPage?.path).toBe('Progetto 2027/_index.md');

    const linksAfterRename = await readJson(
      app.request('/v1/links?path=_index.md', { headers }),
    );
    expect(linksAfterRename.outgoing[0].path).toBe('Progetto 2027/_index.md');
  });

  it('quando elimina automaticamente un link a pagina eliminata, passa da kb-core salvando lo snapshot nello storico', async () => {
    const { app } = await setupTestApp();

    const target = await readJson(
      app.request('/v1/files/create', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'DaEliminare.md', content: 'Temp' }),
      }),
    );

    const originalHostContent = `Riga iniziale\nVedi [[page:${target.pageId}]] per dettagli.\nRiga finale\n`;
    await app.request('/v1/files/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'Ospite.md', content: originalHostContent }),
    });

    // Elimina la pagina target: Ospite.md viene ripulita passando da kb.write -> snapshot salvato!
    const delRes = await app.request('/v1/files/DaEliminare.md', {
      method: 'DELETE',
      headers,
    });
    expect(delRes.status).toBe(200);

    const hostAfter = await readJson(
      app.request('/v1/files/content?path=Ospite.md', { headers }),
    );
    expect(hostAfter.content).not.toContain(target.pageId);

    const hostHistory = await readJson(
      app.request('/v1/files/history?path=Ospite.md', { headers }),
    );
    expect(hostHistory.entries).toHaveLength(1);

    const snap = await readJson(
      app.request(
        `/v1/files/history/version?path=Ospite.md&id=${hostHistory.entries[0].id}`,
        { headers },
      ),
    );
    expect(snap.content).toContain(originalHostContent);
    expect(snap.content).toMatch(/^---\nid: p_[a-zA-Z0-9_-]+\n---\n/);
  });

  it('gestisce icona emoji e caricamento copertina in kb/allegati/ nascondendo allegati dall\'albero pagine', async () => {
    const { app } = await setupTestApp();
    const created = await readJson(
      app.request('/v1/files/create', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'NotaBella.md', content: 'Contenuto' }),
      }),
    );

    // Carica un PNG 1x1 in kb/allegati/
    const png1x1Base64 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const upRes = await app.request('/v1/attachments', {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'banner test.png', dataBase64: png1x1Base64 }),
    });
    expect(upRes.status).toBe(200);
    const upJson = await readJson(upRes);
    expect(upJson.path).toBe('allegati/banner test.png');

    // Imposta icona e copertina tramite frontmatter-patch
    const p1 = await readJson(
      app.request('/v1/files/frontmatter-patch', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          path: 'NotaBella.md',
          key: 'icona',
          value: '🚀',
          baseVersion: created.file.version,
        }),
      }),
    );
    await app.request('/v1/files/frontmatter-patch', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: 'NotaBella.md',
        key: 'copertina',
        value: upJson.path,
        baseVersion: p1.file.version,
      }),
    });

    const tree = await readJson(app.request('/v1/tree', { headers }));
    const pageMeta = tree.pages.find((p: any) => p.path === 'NotaBella.md');
    expect(pageMeta.icona).toBe('🚀');
    expect(pageMeta.copertina).toBe('allegati/banner test.png');
    expect(tree.pages.some((p: any) => p.path.startsWith('allegati/'))).toBe(false);

    const rawImg = await app.request(
      `/v1/attachments/raw?path=${encodeURIComponent(upJson.path)}`,
      { headers },
    );
    expect(rawImg.status).toBe(200);
    expect(rawImg.headers.get('content-type')).toBe('image/png');
  });
});
