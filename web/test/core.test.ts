import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/core/csv.js';
import { parseFrontmatter } from '../src/core/frontmatter.js';
import {
  applyExternalLinkOnDoc,
  extractEditableLinkTitle,
  findExternalLinkAtPos,
  getActiveInlineStyles,
  parseInlineLine,
  pasteExternalUrlOnDoc,
  toggleInlineStyleOnDoc,
  toggleWikilinkOnDoc,
  updateExistingLinkOnDoc,
} from '../src/core/inlineFormat.js';
import { renderMarkdown } from '../src/core/markdown.js';
import {
  getNoteDisplayName,
  purgeMissingInternalLinksFromMarkdown,
  resolveInternalPageTarget,
} from '../src/core/pages.js';
import { parseWikilinks, replaceWikilinksWithHtml } from '../src/core/wikilinks.js';

describe('Web Core: Wikilinks, Frontmatter, CSV, Markdown', () => {
  it('estrae e converte i wikilink in HTML sicuro', () => {
    const text = 'Vedi [[note/corsa]] oppure [[note/corsa|La Corsa]] e [[nota#Sezione]].';
    const parsed = parseWikilinks(text);
    expect(parsed.length).toBe(3);
    expect(parsed[0]!.target).toBe('note/corsa');
    expect(parsed[1]!.alias).toBe('La Corsa');
    expect(parsed[2]!.heading).toBe('Sezione');

    const html = replaceWikilinksWithHtml(text);
    expect(html).toContain('data-wikilink-target="note%2Fcorsa"');
    expect(html).toContain('La Corsa');
  });

  it('analizza il frontmatter YAML e separa il corpo', () => {
    const raw = `---
titolo: Nota di Test
creato: 2026-11-05
tag:
  - corsa
  - salute
tipo: nota
esempio: true
---

# Titolo Principale
Contenuto della nota.`;

    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toBeTruthy();
    expect(frontmatter?.titolo).toBe('Nota di Test');
    expect(frontmatter?.creato).toBe('2026-11-05');
    expect(frontmatter?.tag).toEqual(['corsa', 'salute']);
    expect(frontmatter?.tipo).toBe('nota');
    expect(frontmatter?.esempio).toBe(true);
    expect(body.trim()).toBe('# Titolo Principale\nContenuto della nota.');
  });

  it('analizza file CSV con virgolette e virgole', () => {
    const csvText = `data,distanza,note
2026-11-01,8.5,"Corsa facile, bel tempo"
2026-11-02,10.0,Fondo lento`;

    const parsed = parseCsv(csvText);
    expect(parsed.headers).toEqual(['data', 'distanza', 'note']);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0]![2]).toBe('Corsa facile, bel tempo');
    expect(parsed.rows[1]![1]).toBe('10.0');
  });

  it('renderizza Markdown sanitizzato con marked e DOMPurify', () => {
    const md = '# Titolo\n\nUn link a [[note/corsa]] e una checkbox:\n\n- [x] Fatto\n\n<script>alert(1)</script>';
    const html = renderMarkdown(md);
    expect(html).toContain('<h1>Titolo</h1>');
    expect(html).toContain('data-wikilink-target');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('<script>');
  });
});

describe('Inline Format Toggle (Bold, Italic, Strike, Code, Wikilink)', () => {
  it('attiva e disattiva il grassetto a parità di selezione senza accumulare asterischi', () => {
    const initial = 'Il flusso dovrebbe essere:';
    // Seleziona "flusso" [3, 9]
    const step1 = toggleInlineStyleOnDoc(initial, 3, 9, 'bold');
    expect(step1.text).toBe('Il **flusso** dovrebbe essere:');
    expect(step1.text.slice(step1.from, step1.to)).toBe('flusso');
    expect(getActiveInlineStyles(step1.text, step1.from, step1.to).bold).toBe(true);

    // Secondo click sulla stessa selezione -> rimuove ** invece di aggiungere ****
    const step2 = toggleInlineStyleOnDoc(step1.text, step1.from, step1.to, 'bold');
    expect(step2.text).toBe('Il flusso dovrebbe essere:');
    expect(step2.from).toBe(3);
    expect(step2.to).toBe(9);
    expect(getActiveInlineStyles(step2.text, step2.from, step2.to).bold).toBe(false);

    // Terzo e quarto click consecutivi
    const step3 = toggleInlineStyleOnDoc(step2.text, step2.from, step2.to, 'bold');
    expect(step3.text).toBe('Il **flusso** dovrebbe essere:');
    const step4 = toggleInlineStyleOnDoc(step3.text, step3.from, step3.to, 'bold');
    expect(step4.text).toBe('Il flusso dovrebbe essere:');
  });

  it('rimuove il grassetto anche quando la selezione col mouse include i delimitatori nascosti **', () => {
    const doc = 'Il **flusso** oggi';
    // Selezione esterna [3, 13] ("**flusso**"), interna [5, 11] ("flusso"), e asimmetriche [3, 11] / [5, 13]
    for (const [from, to] of [
      [5, 11],
      [3, 13],
      [3, 11],
      [5, 13],
    ] as const) {
      const res = toggleInlineStyleOnDoc(doc, from, to, 'bold');
      expect(res.text).toBe('Il flusso oggi');
      expect(res.from).toBe(3);
      expect(res.to).toBe(9);
    }
  });

  it('gestisce selezioni con spazio finale (doppio click) e rimozione parziale dentro una frase bold', () => {
    const doc = 'Il flusso dovrebbe';
    // Doppio click Windows seleziona "flusso " [3, 10]
    const b1 = toggleInlineStyleOnDoc(doc, 3, 10, 'bold');
    expect(b1.text).toBe('Il **flusso** dovrebbe');
    const b2 = toggleInlineStyleOnDoc(b1.text, b1.from, b1.to, 'bold');
    expect(b2.text).toBe('Il flusso dovrebbe');

    // Rimozione parziale di "flusso" dentro "**ciao flusso mondo**"
    const phrase = '**ciao flusso mondo**';
    const partial = toggleInlineStyleOnDoc(phrase, 7, 13, 'bold');
    expect(partial.text).toBe('**ciao** flusso **mondo**');
    expect(partial.text.slice(partial.from, partial.to)).toBe('flusso');
  });

  it('combina correttamente grassetto e corsivo (***testo***) e pulisce eventuali ****testo****', () => {
    const s0 = 'Parola chiave qui';
    const s1 = toggleInlineStyleOnDoc(s0, 7, 13, 'bold');
    expect(s1.text).toBe('Parola **chiave** qui');

    const s2 = toggleInlineStyleOnDoc(s1.text, s1.from, s1.to, 'italic');
    expect(s2.text).toBe('Parola ***chiave*** qui');
    expect(getActiveInlineStyles(s2.text, s2.from, s2.to)).toMatchObject({
      bold: true,
      italic: true,
    });

    // Rimuove solo bold lasciando italic
    const s3 = toggleInlineStyleOnDoc(s2.text, s2.from, s2.to, 'bold');
    expect(s3.text).toBe('Parola *chiave* qui');

    // Pulisce testo con asterischi quadrupli preesistenti
    const dirty = 'Test ****ciao**** fine';
    const parsed = parseInlineLine(dirty, 0);
    expect(parsed.cells.map((c) => c.ch).join('')).toBe('Test ciao fine');
    const cleaned = toggleInlineStyleOnDoc(dirty, 9, 13, 'bold');
    expect(cleaned.text).toBe('Test ciao fine');
  });

  it('attiva e disattiva wikilink [[...]] e ignora asterischi di elenchi o moltiplicazioni', () => {
    const w1 = toggleWikilinkOnDoc('Vedi corsa oggi', 5, 10);
    expect(w1.text).toBe('Vedi [[corsa]] oggi');
    const w2 = toggleWikilinkOnDoc(w1.text, w1.from, w1.to);
    expect(w2.text).toBe('Vedi corsa oggi');

    const bullet = parseInlineLine('* Elemento lista con 2 * 3 * 4', 0);
    expect(bullet.prefixLen).toBe(2);
    expect(bullet.hiddenRanges).toEqual([]);
    expect(bullet.cells.some((c) => c.italic || c.bold)).toBe(false);
  });

  it('distingue link esterni autonomi (favicon/globo + testo) da link incollati su testo esistente', () => {
    // 1. Incolla URL esterno su testo già presente in nota ("esmepio")
    const doc = 'Link UTM\nesmepio';
    const pasted = pasteExternalUrlOnDoc(doc, 9, 16, 'https://tilda.cc/utm/');
    expect(pasted).toBeTruthy();
    expect(pasted!.text).toBe('Link UTM\n[esmepio](https://tilda.cc/utm/)');

    // Il link generato mantiene testo identico ("esmepio") e non è standalone
    const parsedTextLink = parseInlineLine('[esmepio](https://tilda.cc/utm/)', 0);
    expect(parsedTextLink.links).toHaveLength(1);
    expect(parsedTextLink.links[0]).toMatchObject({
      isExternal: true,
      standalone: false,
      label: 'esmepio',
      target: 'https://tilda.cc/utm/',
    });

    // 2. Link esterno autonomo ("solo link"): mostra etichetta pulita ed è marcato standalone
    const parsedBare = parseInlineLine('Visita https://www.tilda.cc/utm/, utile.', 0);
    expect(parsedBare.links).toHaveLength(1);
    expect(parsedBare.links[0]).toMatchObject({
      type: 'autolink',
      isExternal: true,
      standalone: true,
      label: 'tilda.cc/utm',
      target: 'https://www.tilda.cc/utm/',
    });

    // 3. Link preview con Meta Title [Meta Title](url "preview"): standalone = true
    const parsedPreview = parseInlineLine(
      '[Campaign URL Builder](https://tilda.cc/utm/ "preview")',
      0,
    );
    expect(parsedPreview.links).toHaveLength(1);
    expect(parsedPreview.links[0]).toMatchObject({
      type: 'mdlink',
      isExternal: true,
      standalone: true,
      label: 'Campaign URL Builder',
      target: 'https://tilda.cc/utm/',
    });
  });

  it('permette di selezionare e formattare link preview e link normali senza rompere la sintassi', () => {
    // Formattazione bold sull'intero link preview con meta title
    const previewDoc = '[Campaign URL Builder](https://tilda.cc/utm/ "preview")';
    const pLink = parseInlineLine(previewDoc, 0).links[0]!;
    const b1 = toggleInlineStyleOnDoc(previewDoc, pLink.visibleFrom, pLink.visibleTo, 'bold');
    expect(b1.text).toBe('[**Campaign URL Builder**](https://tilda.cc/utm/ "preview")');
    expect(getActiveInlineStyles(b1.text, b1.from, b1.to).bold).toBe(true);

    // Secondo toggle rimuove il bold in modo idempotente
    const b2 = toggleInlineStyleOnDoc(b1.text, b1.from, b1.to, 'bold');
    expect(b2.text).toBe(previewDoc);

    // Formattazione parziale su una sola parola dentro il link preview ("URL")
    const partial = toggleInlineStyleOnDoc(previewDoc, 10, 13, 'italic');
    expect(partial.text).toBe('[Campaign *URL* Builder](https://tilda.cc/utm/ "preview")');

    // Formattazione bold anche su URL autonomo nudo (offline / pre-meta)
    const bareDoc = 'https://tilda.cc/utm';
    const bareLink = parseInlineLine(bareDoc, 0).links[0]!;
    const bareBold = toggleInlineStyleOnDoc(
      bareDoc,
      bareLink.visibleFrom,
      bareLink.visibleTo,
      'bold',
    );
    expect(bareBold.text).toBe('**https://tilda.cc/utm**');
    const bareReparsed = parseInlineLine(bareBold.text, 0);
    expect(bareReparsed.links[0]?.bold).toBe(true);
    expect(bareReparsed.links[0]?.target).toBe('https://tilda.cc/utm');
    const bareUnbold = toggleInlineStyleOnDoc(
      bareBold.text,
      bareBold.from,
      bareBold.to,
      'bold',
    );
    expect(bareUnbold.text).toBe(bareDoc);
  });

  it('modifica titolo e URL di link preview e normali e applica/rimuove link da selezione', () => {
    // Tool Link su testo selezionato
    const applied = applyExternalLinkOnDoc('Leggi questa guida ora', 6, 18, 'tilda.cc/utm');
    expect(applied.text).toBe('Leggi [questa guida](https://tilda.cc/utm) ora');
    expect(applied.text.slice(applied.from, applied.to)).toBe('questa guida');

    // Modifica titolo e URL su link normale
    const foundNormal = findExternalLinkAtPos(applied.text, applied.from)!;
    expect(foundNormal.standalone).toBe(false);
    const updatedNormal = updateExistingLinkOnDoc(
      applied.text,
      foundNormal.from,
      foundNormal.to,
      'Guida UTM',
      'https://example.com/guida',
      foundNormal.standalone,
    );
    expect(updatedNormal.text).toBe('Leggi [Guida UTM](https://example.com/guida) ora');

    // Modifica titolo e URL su link preview boldato preservando lo stile
    const boldPreview = '[**Campaign URL Builder**](https://tilda.cc/utm/ "preview")';
    const foundPreview = findExternalLinkAtPos(boldPreview, 5)!;
    expect(foundPreview.standalone).toBe(true);
    const extracted = extractEditableLinkTitle(foundPreview);
    expect(extracted.cleanTitle).toBe('Campaign URL Builder');
    const updatedPreview = updateExistingLinkOnDoc(
      boldPreview,
      foundPreview.from,
      foundPreview.to,
      `${extracted.wrapPrefix}Generatore UTM${extracted.wrapSuffix}`,
      'https://tilda.cc/nuovo',
      foundPreview.standalone,
    );
    expect(updatedPreview.text).toBe('[**Generatore UTM**](https://tilda.cc/nuovo "preview")');

    // Rimozione link tramite tool Link con URL vuoto
    const removed = applyExternalLinkOnDoc(updatedNormal.text, 7, 16, '');
    expect(removed.text).toBe('Leggi Guida UTM ora');
  });

  it('mantiene immutabile il link [[page:<id>]] alla rinomina aggiornando in sincrono solo il testo di preview e sidebar', () => {
    const noteBody = 'Vai a [[page:p_alpha]] per i dettagli.';
    const initialEntries = [
      { path: 'note/Padre.md', type: 'file' as const, size: 40, mtimeMs: 1, archived: false },
      { path: 'note/Nuova pagina.md', type: 'file' as const, size: 10, mtimeMs: 1, archived: false },
    ];
    const initialPages = [
      { id: 'p_parent', path: 'note/Padre.md' },
      { id: 'p_alpha', path: 'note/Nuova pagina.md' },
    ];

    // 1. Stato iniziale appena creata tramite "/"
    const res1 = resolveInternalPageTarget('page:p_alpha', 'note/Padre.md', initialEntries, initialPages);
    expect(res1).toEqual({
      id: 'p_alpha',
      path: 'note/Nuova pagina.md',
      displayTitle: 'Nuova pagina',
    });

    // 2. Digitazione live del titolo (sincrona tra titolo in alto, sidebar e preview del link)
    const liveDrafts = { 'note/Nuova pagina.md': 'Piano Strategico 2027' };
    expect(getNoteDisplayName('note/Nuova pagina.md', liveDrafts)).toBe('Piano Strategico 2027');
    const resLive = resolveInternalPageTarget(
      'page:p_alpha',
      'note/Padre.md',
      initialEntries,
      initialPages,
      liveDrafts,
    );
    expect(resLive?.displayTitle).toBe('Piano Strategico 2027');

    // 3. Rinomina completata su disco: la connessione [[page:p_alpha]] nel testo NON cambia, cambia solo il testo di preview
    const renamedEntries = [
      { path: 'note/Padre.md', type: 'file' as const, size: 40, mtimeMs: 1, archived: false },
      {
        path: 'note/Piano Strategico 2027.md',
        type: 'file' as const,
        size: 10,
        mtimeMs: 2,
        archived: false,
      },
    ];
    const renamedPages = [
      { id: 'p_parent', path: 'note/Padre.md' },
      {
        id: 'p_alpha',
        path: 'note/Piano Strategico 2027.md',
        previousPaths: ['note/Nuova pagina.md'],
      },
    ];

    expect(noteBody).toBe('Vai a [[page:p_alpha]] per i dettagli.');
    const resAfterRename = resolveInternalPageTarget(
      'page:p_alpha',
      'note/Padre.md',
      renamedEntries,
      renamedPages,
    );
    expect(resAfterRename).toEqual({
      id: 'p_alpha',
      path: 'note/Piano Strategico 2027.md',
      displayTitle: 'Piano Strategico 2027',
    });

    const renderedHtml = renderMarkdown(noteBody, (target) =>
      resolveInternalPageTarget(target, 'note/Padre.md', renamedEntries, renamedPages),
    );
    expect(renderedHtml).toContain('Piano Strategico 2027');
    expect(renderedHtml).not.toContain('p_alpha');
  });

  it('elimina automaticamente i link interni a pagine non esistenti preservando link esterni e blocchi codice', () => {
    const entries = [
      { path: 'note/Esistente.md', type: 'file' as const, size: 12, mtimeMs: 1, archived: false },
    ];
    const pages = [{ id: 'p_ok', path: 'note/Esistente.md' }];

    const doc = [
      'Valido: [[page:p_ok]] e rotto: [[non-esiste]] fine.',
      '- [[altra-mancante]]',
      'Link md interno rotto: [Vecchia](mancante.md) ma esterno salvo: [Sito](https://example.com)',
      'Codice inline salvo: `[[non-toccare]]`',
      '```python',
      '# [[non-toccare-in-blocco]]',
      '```',
    ].join('\n');

    const cleaned = purgeMissingInternalLinksFromMarkdown(doc, 'note/Padre.md', entries, pages);
    expect(cleaned).toContain('[[page:p_ok]]');
    expect(cleaned).not.toContain('[[non-esiste]]');
    expect(cleaned).not.toContain('altra-mancante');
    expect(cleaned).not.toContain('[Vecchia](mancante.md)');
    expect(cleaned).toContain('[Sito](https://example.com)');
    expect(cleaned).toContain('`[[non-toccare]]`');
    expect(cleaned).toContain('# [[non-toccare-in-blocco]]');

    // Se anche la pagina collegata viene eliminata, il link pagina viene rimosso
    const afterDelete = purgeMissingInternalLinksFromMarkdown(cleaned, 'note/Padre.md', [], []);
    expect(afterDelete).toBe(afterDelete); // Con albero vuoto (pre-caricamento) non tocca nulla
    const afterConfirmedDelete = purgeMissingInternalLinksFromMarkdown(
      cleaned,
      'note/Padre.md',
      [{ path: 'note/Padre.md', type: 'file', size: 10, mtimeMs: 1, archived: false }],
      [{ id: 'p_parent', path: 'note/Padre.md' }],
    );
    expect(afterConfirmedDelete).not.toContain('[[page:p_ok]]');
  });
});
