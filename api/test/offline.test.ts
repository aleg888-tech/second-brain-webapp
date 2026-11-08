import { describe, expect, it } from 'vitest';
import { KbService, MemoryHistoryStore, MemoryStorage } from '@brain/kb-core';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

describe('Funzionamento offline senza AI e senza rete', () => {
  const dummyToken = 'offline-test-token-abcdef';

  const config: AppConfig = {
    projectRoot: '/dummy/root',
    kbDir: '/dummy/root/kb',
    historyDir: '/dummy/root/.brain/history',
    localJsonPath: '/dummy/root/.brain/local.json',
    vistaJsonPath: '/dummy/root/.brain/vista.json',
    port: 4310,
    host: '127.0.0.1',
    webPort: 5173,
    allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    extensions: ['.md', '.csv', '.txt'],
    exclude: ['_archivio', '.git'],
    agentDeny: ['segreto'],
    agentUrl: '',
  };

  const storage = new MemoryStorage();
  const history = new MemoryHistoryStore();
  const kb = new KbService({
    storage,
    history,
    extensions: config.extensions,
    exclude: config.exclude,
    agentDeny: config.agentDeny,
  });

  const app = createApp({ config, kb, token: dummyToken });

  const headers = {
    host: '127.0.0.1:4310',
    authorization: `Bearer ${dummyToken}`,
  };

  it('lo stato dell\'agente indica che l\'AI è disabilitata', async () => {
    const res = await app.request('/v1/agent/status', { headers });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.configured).toBe(false);
    expect(data.model).toBeNull();
    expect(data.maxSteps).toBe(0);
  });

  it('l\'API gestisce completamente file, directory, ricerca, storico e vista senza rete', async () => {
    // 1. Creazione file
    const createRes = await app.request('/v1/files/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'note/offline-test.md', content: '# Nota Offline\nFunziona senza internet.' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as any;
    expect(created.file.path).toBe('note/offline-test.md');

    // 2. Lettura file
    const readRes = await app.request('/v1/files/content?path=note/offline-test.md', { headers });
    expect(readRes.status).toBe(200);
    const read = (await readRes.json()) as any;
    expect(read.content).toContain('Funziona senza internet');

    // 3. Modifica con storico
    const writeRes = await app.request('/v1/files/content', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: 'note/offline-test.md',
        content: '# Nota Offline\nVersione aggiornata in locale.',
        baseVersion: read.version,
      }),
    });
    expect(writeRes.status).toBe(200);

    // 4. Storico
    const histRes = await app.request('/v1/files/history?path=note/offline-test.md', { headers });
    expect(histRes.status).toBe(200);
    const hist = (await histRes.json()) as any;
    expect(hist.entries.length).toBe(1);

    // 5. Ricerca
    const searchRes = await app.request('/v1/search?q=locale', { headers });
    expect(searchRes.status).toBe(200);
    const search = (await searchRes.json()) as any;
    expect(search.hits.length).toBe(1);

    // 6. Vista
    const vistaRes = await app.request('/v1/vista', { headers });
    expect(vistaRes.status).toBe(200);
    const vista = (await vistaRes.json()) as any;
    expect(vista).toHaveProperty('theme');
  });

  it('mantiene immutabile [[page:<id>]] alla rinomina ed elimina i link interni se la pagina non esiste', async () => {
    // 1. Crea una nuova pagina collegata (come con il comando /Pagina)
    const createChildRes = await app.request('/v1/files/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'note/Nuova pagina.md', content: '' }),
    });
    expect(createChildRes.status).toBe(200);
    const createdChild = (await createChildRes.json()) as any;
    expect(createdChild.pageId).toMatch(/^p_/);
    const childId = createdChild.pageId as string;

    // 2. Crea la nota padre con un link valido [[page:<id>]] e uno verso pagina inesistente [[fantasma]]
    const createParentRes = await app.request('/v1/files/create', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: 'note/Padre.md',
        content: `Collegamento valido: [[page:${childId}]] e rotto: [[fantasma]]`,
      }),
    });
    expect(createParentRes.status).toBe(200);

    // Il link verso pagina inesistente viene subito eliminato
    const parentRead1 = (await (
      await app.request('/v1/files/content?path=note/Padre.md', { headers })
    ).json()) as any;
    expect(parentRead1.content).toContain(`[[page:${childId}]]`);
    expect(parentRead1.content).not.toContain('fantasma');

    // 3. Rinomina la pagina figlia: la connessione [[page:<id>]] nel padre NON cambia
    const renameRes = await app.request('/v1/files/rename', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: 'note/Nuova pagina.md',
        to: 'note/Titolo Rinominato.md',
      }),
    });
    expect(renameRes.status).toBe(200);

    const parentRead2 = (await (
      await app.request('/v1/files/content?path=note/Padre.md', { headers })
    ).json()) as any;
    expect(parentRead2.content).toContain(`[[page:${childId}]]`);

    // L'albero associa lo stesso pageId al nuovo percorso e /v1/links risolve la connessione come valida
    const treeData = (await (await app.request('/v1/tree', { headers })).json()) as any;
    const pageRec = treeData.pages.find((p: any) => p.id === childId);
    expect(pageRec?.path).toBe('note/Titolo Rinominato.md');

    const linksData = (await (
      await app.request('/v1/links?path=note/Padre.md', { headers })
    ).json()) as any;
    expect(linksData.outgoing.length).toBe(1);
    expect(linksData.outgoing[0].status).toBe('ok');
    expect(linksData.outgoing[0].target).toBe(`page:${childId}`);
    expect(linksData.outgoing[0].path).toBe('note/Titolo Rinominato.md');

    const childLinks = (await (
      await app.request(
        `/v1/links?path=${encodeURIComponent('note/Titolo Rinominato.md')}`,
        { headers },
      )
    ).json()) as any;
    expect(childLinks.backlinks.some((b: any) => b.path === 'note/Padre.md')).toBe(true);

    // 4. Elimina la pagina collegata: il link pagina viene automaticamente eliminato dal padre
    const delRes = await app.request(
      `/v1/files/${encodeURIComponent('note/Titolo Rinominato.md')}`,
      {
        method: 'DELETE',
        headers,
      },
    );
    expect(delRes.status).toBe(200);

    const parentRead3 = (await (
      await app.request('/v1/files/content?path=note/Padre.md', { headers })
    ).json()) as any;
    expect(parentRead3.content).not.toContain(childId);
  });
});
