import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsHistoryStore, MemoryHistoryStore } from '../src/history.js';
import { KbService, VIRTUAL_INDEX_VERSION } from '../src/kb-service.js';
import { FsStorage } from '../src/storage/fs-storage.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

describe('Fase 1 — Modello a pagine-nodo, conversione atomica, rinomina e Home', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeFsService() {
    const base = await mkdtemp(path.join(tmpdir(), 'brain-phase1-'));
    tempDirs.push(base);
    const kbRoot = path.join(base, 'kb');
    const histRoot = path.join(base, 'history');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(kbRoot, { recursive: true });
    await mkdir(histRoot, { recursive: true });

    const storage = new FsStorage(kbRoot);
    const history = new FsHistoryStore(histRoot);
    const kb = new KbService({
      storage,
      history,
      extensions: ['.md', '.csv', '.txt'],
      exclude: ['_archivio', '.git'],
      now: () => new Date('2026-11-07T10:00:00Z'),
    });
    return { kb, storage, history, kbRoot };
  }

  function makeMemService() {
    const storage = new MemoryStorage();
    const history = new MemoryHistoryStore();
    const kb = new KbService({
      storage,
      history,
      extensions: ['.md', '.csv', '.txt'],
      exclude: ['_archivio', '.git'],
      now: () => new Date('2026-11-07T10:00:00Z'),
    });
    return { kb, storage, history };
  }

  it('cartelle esistenti senza _index.md non creano file alla navigazione, ma solo quando si aggiunge contenuto', async () => {
    const { kb, storage } = makeFsService ? await makeFsService() : makeMemService();
    await kb.create('domini/figlia.md', '# Figlia\nContenuto.');

    // Verifica che domini/_index.md non esista su disco
    expect(await storage.stat('domini/_index.md')).toBeNull();

    // Navigazione/lettura: restituisce indice virtuale senza creare nulla su disco
    const virt = await kb.readOrVirtualIndex('domini/_index.md');
    expect(virt.virtual).toBe(true);
    expect(virt.content).toBe('');
    expect(virt.version).toBe(VIRTUAL_INDEX_VERSION);
    expect(await storage.stat('domini/_index.md')).toBeNull();

    // Salvataggio a vuoto: continua a non creare nulla su disco
    const emptySave = await kb.write('domini/_index.md', '', virt.version);
    expect(emptySave.file.virtual).toBe(true);
    expect(await storage.stat('domini/_index.md')).toBeNull();

    // Aggiunta di contenuto reale: ora materializza _index.md su disco
    const realSave = await kb.write('domini/_index.md', 'Introduzione ai domini.\n', virt.version);
    expect(realSave.file.virtual).toBeUndefined();
    expect(await storage.stat('domini/_index.md')).not.toBeNull();
    const diskRead = await kb.read('domini/_index.md');
    expect(diskRead.content).toBe('Introduzione ai domini.\n');
  });

  it('Home (kb/_index.md) mantiene il nome fisso, non può essere eliminata/archiviata, ma supporta icona e copertina', async () => {
    const { kb } = makeMemService();
    const home = await kb.create('_index.md', '# Benvenuto\n');

    await expect(kb.rename('_index.md', 'AltroNome.md')).rejects.toMatchObject({ status: 400 });
    await expect(kb.archive('_index.md')).rejects.toMatchObject({ status: 400 });
    await expect(kb.delete('_index.md')).rejects.toMatchObject({ status: 400 });

    const p1 = await kb.patchFrontmatter('_index.md', 'icona', '🏠', home.file.version);
    const p2 = await kb.patchFrontmatter(
      '_index.md',
      'copertina',
      '#dbeafe',
      p1.file.version,
    );
    expect(p2.content).toContain('icona:');
    expect(p2.content).toContain('🏠');
    expect(p2.content).toContain('copertina: "#dbeafe"');
    expect(p2.content).toContain('# Benvenuto\n');

    const hist = await kb.historyList('_index.md');
    expect(hist.length).toBe(2);
  });

  it('converte atomicamente foglia -> nodo preservando dati byte-per-byte, CRLF e storico versioni (senza conversione inversa)', async () => {
    const { kb, storage } = await makeFsService();
    const v1 = '---\r\ntitolo: "Idea"\r\n---\r\n\r\nBozza 1\r\n';
    const v2 = '---\r\ntitolo: "Idea"\r\n---\r\n\r\nBozza 2 definitiva\r\n';

    await storage.create('note/progetto.md', v1);
    const r1 = await kb.read('note/progetto.md');
    await kb.write('note/progetto.md', v2, r1.version);

    const conv = await kb.convertLeafToNode('note/progetto.md');
    expect(conv.from).toBe('note/progetto.md');
    expect(conv.to).toBe('note/progetto/_index.md');
    expect(conv.historyId).toBeTruthy();

    // La vecchia foglia non esiste più, il nodo esiste con identico contenuto CRLF
    expect(await storage.stat('note/progetto.md')).toBeNull();
    const nodeDoc = await kb.read('note/progetto/_index.md');
    expect(nodeDoc.content).toBe(v2);
    expect(nodeDoc.eol).toBe('crlf');

    // Lo storico ha seguito la pagina (contiene sia v1 sia lo snapshot pre-conversione v2)
    const hist = await kb.historyList('note/progetto/_index.md');
    expect(hist.length).toBe(2);
    const oldest = await kb.historyGet('note/progetto/_index.md', hist[hist.length - 1]!.id);
    expect(oldest).toBe(v1);

    // Aggiunge e poi elimina un figlio: nessuna conversione inversa automatica
    await kb.create('note/progetto/task-1.md', 'Task');
    await kb.delete('note/progetto/task-1.md');
    expect(await storage.stat('note/progetto/_index.md')).not.toBeNull();
  });

  it('rinomina pagina-nodo: rinomina la cartella lasciando _index.md invariato, rifiuta collisioni/nomi non validi e gestisce solo maiuscole su Windows', async () => {
    const { kb, kbRoot } = await makeFsService();

    // Crea pagina-nodo con storico e una sottopagina con storico
    const idx = await kb.create('domini/corsa/_index.md', ' V1 corsa');
    await kb.write('domini/corsa/_index.md', 'V2 corsa', idx.file.version);
    const sub = await kb.create('domini/corsa/scarpe.md', 'S1');
    await kb.write('domini/corsa/scarpe.md', 'S2', sub.file.version);

    // Crea anche una pagina foglia sorella per testare le collisioni incrociate
    await kb.create('domini/nuoto.md', 'Foglia nuoto');
    await kb.create('domini/ciclismo/_index.md', 'Nodo ciclismo');

    // 1. Collisione nodo -> nome di foglia esistente (`domini/nuoto.md`)
    await expect(kb.rename('domini/corsa/_index.md', 'domini/nuoto')).rejects.toMatchObject({
      status: 409,
    });

    // 2. Collisione foglia -> nome di nodo esistente (`domini/ciclismo/`)
    await expect(kb.rename('domini/nuoto.md', 'domini/ciclismo.md')).rejects.toMatchObject({
      status: 409,
    });

    // 3. Collisione nodo -> nodo esistente
    await expect(kb.rename('domini/corsa', 'domini/ciclismo')).rejects.toMatchObject({
      status: 409,
    });

    // 4. Nomi non validi su Windows
    await expect(kb.rename('domini/corsa', 'domini/CON')).rejects.toMatchObject({ status: 400 });
    await expect(kb.rename('domini/corsa', 'domini/nome?errato')).rejects.toMatchObject({
      status: 400,
    });
    await expect(kb.rename('domini/corsa', 'domini/spaziofinale ')).rejects.toMatchObject({
      status: 400,
    });

    // 5. Rinomina cambiando SOLO maiuscole/minuscole (`corsa` -> `Corsa`) su vero filesystem Windows
    const caseRes = await kb.rename('domini/corsa/_index.md', 'domini/Corsa');
    expect(caseRes).toEqual({ from: 'domini/corsa', to: 'domini/Corsa' });
    const realDominiEntries = await readdir(path.join(kbRoot, 'domini'));
    expect(realDominiEntries).toContain('Corsa');
    expect(realDominiEntries).not.toContain('corsa');

    // Il file interno si chiama ancora esattamente `_index.md` e lo storico ha seguito il nodo e i figli
    const corsaFiles = await readdir(path.join(kbRoot, 'domini', 'Corsa'));
    expect(corsaFiles).toContain('_index.md');
    expect((await kb.historyList('domini/Corsa/_index.md')).length).toBe(1);
    expect((await kb.historyList('domini/Corsa/scarpe.md')).length).toBe(1);

    // 6. Rinomina completa (`Corsa` -> `Atletica Leggera`)
    const fullRes = await kb.rename('domini/Corsa', 'domini/Atletica Leggera');
    expect(fullRes).toEqual({ from: 'domini/Corsa', to: 'domini/Atletica Leggera' });
    expect((await kb.read('domini/Atletica Leggera/_index.md')).content).toBe('V2 corsa');
    expect((await kb.historyList('domini/Atletica Leggera/_index.md')).length).toBe(1);
  });
});
