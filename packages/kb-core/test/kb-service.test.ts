import { describe, expect, it } from 'vitest';
import { MemoryHistoryStore } from '../src/history.js';
import { KbService } from '../src/kb-service.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

describe('KbService (kb-core)', () => {
  function makeService() {
    const storage = new MemoryStorage();
    const history = new MemoryHistoryStore();
    const kb = new KbService({
      storage,
      history,
      extensions: ['.md', '.csv', '.txt'],
      exclude: ['_archivio', '.git'],
      agentDeny: ['segreto', 'personale/finanze'],
      now: () => new Date('2026-11-05T12:00:00Z'),
    });
    return { kb, storage, history };
  }

  it('crea e legge un file markdown con LF', async () => {
    const { kb } = makeService();
    const created = await kb.create('note/prima-nota.md', '# Titolo\nContenuto nota.');
    expect(created.file.path).toBe('note/prima-nota.md');
    expect(created.file.eol).toBe('lf');

    const read = await kb.read('note/prima-nota.md');
    expect(read.content).toBe('# Titolo\nContenuto nota.');
    expect(read.version).toBe(created.file.version);
  });

  it('controllo di concorrenza ottimistica: 409 su baseVersion errata', async () => {
    const { kb } = makeService();
    const created = await kb.create('note/test.md', 'Versione 1');

    const write1 = await kb.write('note/test.md', 'Versione 2', created.file.version);
    expect(write1.historyId).toBeTruthy();

    await expect(kb.write('note/test.md', 'Versione 3 concorrente', created.file.version)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
  });

  it('mantiene il fine riga originale CRLF', async () => {
    const { kb, storage } = makeService();
    await storage.create('note/windows.md', 'Riga 1\r\nRiga 2\r\n');

    const read = await kb.read('note/windows.md');
    expect(read.eol).toBe('crlf');

    const updated = await kb.write('note/windows.md', 'Riga 1\nRiga 2 modificata\n', read.version);
    expect(updated.file.eol).toBe('crlf');

    const reread = await kb.read('note/windows.md');
    expect(reread.content).toBe('Riga 1\r\nRiga 2 modificata\r\n');
  });

  it('salva snapshot nello storico e supporta il ripristino reversibile', async () => {
    const { kb } = makeService();
    const c = await kb.create('note/storia.md', 'V1');
    await kb.write('note/storia.md', 'V2', c.file.version);
    const readV2 = await kb.read('note/storia.md');
    await kb.write('note/storia.md', 'V3', readV2.version);

    const history = await kb.historyList('note/storia.md');
    expect(history.length).toBe(2);

    const oldestId = history[history.length - 1]!.id;
    const restored = await kb.restore('note/storia.md', oldestId);
    expect(restored.historyId).toBeTruthy();

    const current = await kb.read('note/storia.md');
    expect(current.content).toBe('V1');
  });

  it('archivia senza mai cancellare', async () => {
    const { kb } = makeService();
    await kb.create('note/da-archiviare.md', 'Importante ma vecchio');

    const treeBefore = await kb.tree();
    expect(treeBefore.some((e) => e.path === 'note/da-archiviare.md')).toBe(true);

    const res = await kb.archive('note/da-archiviare.md');
    expect(res.to).toBe('_archivio/2026-11-05/note/da-archiviare.md');

    const treeAfter = await kb.tree(false);
    expect(treeAfter.some((e) => e.path === 'note/da-archiviare.md')).toBe(false);
    expect(treeAfter.some((e) => e.path.startsWith('_archivio'))).toBe(false);

    const treeWithArchived = await kb.tree(true);
    expect(treeWithArchived.some((e) => e.path === res.to)).toBe(true);
  });

  it('estrae wikilink e risolve i backlink', async () => {
    const { kb } = makeService();
    await kb.create('note/destinazione.md', '# Nota Destinazione');
    await kb.create('note/sorgente.md', 'Ecco un link a [[note/destinazione]] e uno rotto a [[inesistente]].');

    const linksSorgente = await kb.linksOf('note/sorgente.md');
    expect(linksSorgente.outgoing.length).toBe(2);
    expect(linksSorgente.outgoing[0]!.target).toBe('note/destinazione');
    expect(linksSorgente.outgoing[0]!.status).toBe('ok');
    expect(linksSorgente.outgoing[1]!.status).toBe('broken');

    const linksDest = await kb.linksOf('note/destinazione.md');
    expect(linksDest.backlinks.length).toBe(1);
    expect(linksDest.backlinks[0]!.path).toBe('note/sorgente.md');
  });

  it('esegue ricerche testuali nei file', async () => {
    const { kb } = makeService();
    await kb.create('note/corsa.md', '# Allenamento\nOggi 10km a ritmo medio');
    await kb.create('note/cucina.md', '# Ricetta\nOggi pasta al forno');

    const searchRes = await kb.search('ritmo');
    expect(searchRes.hits.length).toBe(1);
    expect(searchRes.hits[0]!.path).toBe('note/corsa.md');
  });

  it('rispetta la configurazione agentDeny', () => {
    const { kb } = makeService();
    expect(kb.isPathDenied('segreto/password.txt')).toBe(true);
    expect(kb.isPathDenied('personale/finanze/estratto.csv')).toBe(true);
    expect(kb.isPathDenied('note/normale.md')).toBe(false);
    expect(() => kb.assertNotDenied('segreto/doc.md')).toThrow(/agentdeny/i);
  });
});
