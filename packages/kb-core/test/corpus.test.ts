import { describe, expect, it } from 'vitest';
import { MemoryHistoryStore } from '../src/history.js';
import { KbService } from '../src/kb-service.js';
import { MemoryStorage } from '../src/storage/memory-storage.js';

describe('Corpus di File Scomodi e Hardening di Sicurezza Dati', () => {
  function makeService() {
    const storage = new MemoryStorage();
    const history = new MemoryHistoryStore();
    const kb = new KbService({
      storage,
      history,
      extensions: ['.md', '.csv', '.txt'],
      exclude: ['_archivio', '.git'],
      agentDeny: ['segreto'],
      now: () => new Date('2026-11-05T12:00:00Z'),
    });
    return { kb, storage, history };
  }

  it('Punto 5: Salvare senza modifiche non scrive nulla e non genera snapshot', async () => {
    const { kb } = makeService();
    const initialContent = '# Titolo Intatto\nTesto invariato.';
    const created = await kb.create('note/invariato.md', initialContent);

    // Salvataggio dello stesso identico contenuto
    const res = await kb.write('note/invariato.md', initialContent, created.file.version);
    expect(res.historyId).toBeNull();

    // Lo storico deve essere completamente vuoto
    const history = await kb.historyList('note/invariato.md');
    expect(history.length).toBe(0);
  });

  it('Corpus scomodo: Blocchi codice con # commenti, --- e wikilink intatti byte per byte', async () => {
    const { kb } = makeService();
    const trickyContent = [
      '---',
      '# Commento dentro YAML',
      'titolo: "Test Scomodo"',
      'tag: [uno, due]',
      '---',
      '',
      '# Intestazione Reale',
      '',
      'Ecco un blocco di codice Python con commento:',
      '```python',
      '# Questo non è un titolo markdown',
      'x = 10',
      '---',
      '# [[Non è un wikilink]]',
      '```',
      '',
      'E una tabella Markdown:',
      '| Colonna 1 | Colonna 2 |',
      '| --- | --- |',
      '| Valore A | Valore B |',
      '',
      'Caratteri speciali ed emoji: àèìòù, 🧠, 🚀, ñ, ç.',
      'Spazi finali volutamente lasciati:     ',
      '',
    ].join('\n');

    const created = await kb.create('note/tricky.md', trickyContent);
    const read = await kb.read('note/tricky.md');

    // Il contenuto deve essere identico carattere per carattere
    expect(read.content).toBe(trickyContent);

    // Salvataggio senza modifiche: nessun commit
    const saveNoChange = await kb.write('note/tricky.md', trickyContent, read.version);
    expect(saveNoChange.historyId).toBeNull();
  });

  it('Preservazione esatta dei fine riga CRLF di Windows', async () => {
    const { kb, storage } = makeService();
    const crlfDoc = '---\r\ntitolo: Nota Windows\r\n---\r\n\r\n# H1\r\nRiga 1\r\nRiga 2\r\n';
    await storage.create('note/crlf.md', crlfDoc);

    const read = await kb.read('note/crlf.md');
    expect(read.content).toBe(crlfDoc);
    expect(read.eol).toBe('crlf');

    // Scrittura con aggiunta
    const updated = await kb.write('note/crlf.md', crlfDoc + 'Riga 3\r\n', read.version);
    expect(updated.file.eol).toBe('crlf');

    const reread = await kb.read('note/crlf.md');
    expect(reread.content).toBe(crlfDoc + 'Riga 3\r\n');
  });

  it('Spostamento/Drag & Drop: sposta file e cartelle preservando storico e integrità', async () => {
    const { kb } = makeService();
    const c = await kb.create('note/sorgente.md', 'V1 originale');
    await kb.write('note/sorgente.md', 'V2 aggiornato', c.file.version);

    // Spostamento dentro un'altra cartella (simula Drag & Drop o funzione Sposta)
    const moveRes = await kb.rename('note/sorgente.md', 'domini/progetto/destinazione.md');
    expect(moveRes.from).toBe('note/sorgente.md');
    expect(moveRes.to).toBe('domini/progetto/destinazione.md');

    // Il vecchio percorso non esiste più
    await expect(kb.read('note/sorgente.md')).rejects.toMatchObject({ status: 404 });

    // Il nuovo percorso contiene il contenuto aggiornato
    const moved = await kb.read('domini/progetto/destinazione.md');
    expect(moved.content).toBe('V2 aggiornato');

    // Lo storico delle versioni si è spostato con il file
    const hist = await kb.historyList('domini/progetto/destinazione.md');
    expect(hist.length).toBe(1);
  });
});
