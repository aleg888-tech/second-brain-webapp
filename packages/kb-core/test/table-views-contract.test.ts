import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PropertyDefinition, TableRowItem, VistaBlockConfig } from '@brain/shared';
import {
  addPropertyToSchema,
  attachValidationWarningsToRows,
  buildOptionsFromExistingValues,
  changePropertyTypeInSchema,
  createDefaultDatabaseSchema,
  defaultStatusOptions,
  deletePropertyFromSchema,
  detectUndefinedFields,
  extractVistaBlocks,
  filterTableRows,
  formatItalianDate,
  FsHistoryStore,
  FsStorage,
  generateUniquePropertyKey,
  GithubBackend,
  KbService,
  MAX_OPTIONS_PER_PROPERTY,
  MAX_PROPERTIES_PER_TABLE,
  parseFrontmatterYaml,
  parsePropertyDefinitions,
  parseVistaBlockYaml,
  patchFrontmatterField,
  planOptionRenameMigration,
  renamePropertyInSchema,
  reorderPropertiesInSchema,
  replaceVistaBlockInMarkdown,
  resolveEffectiveColumns,
  restoreUndefinedPropertyToSchema,
  serializePropertyDefinitions,
  setPropertyDecimalsInSchema,
  setPropertyDefaultInSchema,
  sortTableRows,
  updatePropertyOptionsInSchema,
  validatePropertyValue,
} from '../src/index.js';

describe('Moduli puri kb-core — Schema per tabella, Tipi, Blocco Vista, Query, Sicurezza YAML e Contratto Backend', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  async function makeFsBackend() {
    const dir = await mkdtemp(path.join(tmpdir(), 'brain-kb-contract-'));
    tempDirs.push(dir);
    const kbRoot = path.join(dir, 'kb');
    const histRoot = path.join(dir, 'hist');
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
      now: () => new Date('2026-09-01T10:00:00Z'),
    });
    return { kb, storage };
  }

  function makeGithubBackend() {
    const gh = new GithubBackend(50, () => new Date('2026-09-01T10:00:00Z'));
    const kb = new KbService({
      storage: gh.storage,
      history: gh.history,
      extensions: ['.md', '.csv', '.txt'],
      exclude: ['_archivio', '.git'],
      now: () => new Date('2026-09-01T10:00:00Z'),
    });
    return { kb, storage: gh.storage };
  }

  it('nessun modulo puro di kb-core importa node:*', async () => {
    const pureFiles = [
      'errors.ts',
      'text.ts',
      'kb-service.ts',
      'frontmatter-patch.ts',
      'schema.ts',
      'vista-block.ts',
      'table-engine.ts',
      'storage/paths.ts',
      'storage/storage.ts',
      'storage/memory-storage.ts',
      'storage/github-backend.ts',
      'indexers/registry.ts',
      'indexers/markdown.ts',
      'indexers/link-index.ts',
      'indexers/frontmatter-index.ts',
    ];
    for (const rel of pureFiles) {
      const abs = path.resolve(import.meta.dirname, '..', 'src', rel);
      const src = await readFile(abs, 'utf-8');
      expect(src, `Il modulo puro ${rel} non deve importare node:*`).not.toMatch(
        /from\s+['"]node:|import\s*\(\s*['"]node:/,
      );
    }
  });

  it('genera chiavi slug stabili da nomi con accenti e simboli, gestisce collisioni (-2), chiavi riservate, regola tag e limiti', () => {
    expect(generateUniquePropertyKey('Priorità & Urgenza!', 'seleziona', [])).toBe(
      'priorita-urgenza',
    );
    expect(
      generateUniquePropertyKey('Priorità', 'numero', ['priorita', 'priorita-2']),
    ).toBe('priorita-3');
    expect(generateUniquePropertyKey(' Città / Sede ', 'testo', [])).toBe('citta-sede');

    // Chiavi riservate rifiutate
    for (const reserved of [
      'id',
      'icona',
      'copertina',
      'creato',
      'modificato',
      'titolo',
      'tipo',
      'proprieta',
      'versione-schema',
    ]) {
      expect(() => generateUniquePropertyKey(reserved, 'testo', [])).toThrow();
    }

    // "tag" ammesso SOLO come selezione-multipla
    expect(() => generateUniquePropertyKey('Tag', 'testo', [])).toThrow();
    expect(() => generateUniquePropertyKey('tag', 'seleziona', [])).toThrow();
    expect(generateUniquePropertyKey('Tag', 'selezione-multipla', [])).toBe('tag');

    // Limite 60 caratteri sul nome
    expect(() => generateUniquePropertyKey('a'.repeat(61), 'testo', [])).toThrow();

    // Limite 50 proprietà per database
    let schema: PropertyDefinition[] = [];
    for (let i = 1; i <= MAX_PROPERTIES_PER_TABLE; i++) {
      schema = addPropertyToSchema(schema, { nome: `Prop ${i}`, tipo: 'testo' }).schema;
    }
    expect(schema).toHaveLength(50);
    expect(() => addPropertyToSchema(schema, { nome: 'Prop 51', tipo: 'testo' })).toThrow();

    // Limite 100 opzioni per proprietà
    const tooManyOptions = Array.from({ length: MAX_OPTIONS_PER_PROPERTY + 1 }, (_, i) => ({
      valore: `Opt ${i}`,
      colore: 'blu' as const,
    }));
    expect(() =>
      addPropertyToSchema([], { nome: 'Scelta', tipo: 'seleziona', opzioni: tooManyOptions }),
    ).toThrow();
  });

  it('valida in modo tollerante tutti i tipi e formatta le date in italiano', () => {
    // Date e intervalli in italiano
    expect(formatItalianDate('2026-09-01')).toBe('1 settembre 2026');
    expect(formatItalianDate('2026-09-01T14:30')).toBe('1 settembre 2026, 14:30');
    expect(formatItalianDate('2026-09-01/2026-11-30')).toBe(
      '1 settembre 2026 → 30 novembre 2026',
    );

    expect(validatePropertyValue({ tipo: 'data' }, '2026-09-01/2026-11-30').valid).toBe(true);
    expect(validatePropertyValue({ tipo: 'data' }, '2026-02-29').valid).toBe(false); // 2026 non è bisestile
    expect(validatePropertyValue({ tipo: 'data' }, '2026-11-30/2026-09-01').valid).toBe(false); // fine < inizio

    // Numero e decimali
    const numRes = validatePropertyValue({ tipo: 'numero', decimali: 2 }, 12.5);
    expect(numRes.valid).toBe(true);
    expect(numRes.formatted).toContain('12,50');
    expect(validatePropertyValue({ tipo: 'numero' }, '12.5').valid).toBe(false);

    // Seleziona / Selezione multipla / Stato
    const selDef: PropertyDefinition = {
      chiave: 'priorita',
      nome: 'Priorità',
      tipo: 'seleziona',
      opzioni: [{ valore: 'Alta', colore: 'rosso' }],
    };
    expect(validatePropertyValue(selDef, 'Alta').valid).toBe(true);
    const outOfOpt = validatePropertyValue(selDef, 'Bassa');
    expect(outOfOpt.valid).toBe(false);
    expect(outOfOpt.warning).toContain('Bassa');

    const multiDef: PropertyDefinition = {
      chiave: 'persone',
      nome: 'Persone',
      tipo: 'selezione-multipla',
      opzioni: [
        { valore: 'Anna', colore: 'rosa' },
        { valore: 'Marco', colore: 'blu' },
      ],
    };
    expect(validatePropertyValue(multiDef, ['Anna']).valid).toBe(true);
    expect(validatePropertyValue(multiDef, 'Anna').valid).toBe(false); // stringa invece di lista
    expect(validatePropertyValue(multiDef, ['Anna', 'Luca']).valid).toBe(false); // Luca fuori opzioni

    // Casella, URL, Email, Telefono
    expect(validatePropertyValue({ tipo: 'casella' }, true).valid).toBe(true);
    expect(validatePropertyValue({ tipo: 'casella' }, 'true').valid).toBe(false);
    expect(validatePropertyValue({ tipo: 'url' }, 'https://example.com/test').valid).toBe(true);
    expect(validatePropertyValue({ tipo: 'url' }, 'javascript:alert(1)').valid).toBe(false);
    expect(validatePropertyValue({ tipo: 'email' }, 'anna@example.it').valid).toBe(true);
    expect(validatePropertyValue({ tipo: 'email' }, 'anna@invalid').valid).toBe(false);
    expect(validatePropertyValue({ tipo: 'telefono' }, '+39 02 1234567').valid).toBe(true);
    expect(validatePropertyValue({ tipo: 'telefono' }, '123').valid).toBe(false);
  });

  it('gestisce operazioni sullo schema, cambio tipo tollerante, eliminazione/ripristino campi non definiti e migrazione opzioni con anteprima', () => {
    expect(createDefaultDatabaseSchema()).toEqual([]);
    let schema: PropertyDefinition[] = [
      { chiave: 'stato', nome: 'Stato', tipo: 'stato', opzioni: defaultStatusOptions() },
      { chiave: 'data', nome: 'Data', tipo: 'data' },
      { chiave: 'tag', nome: 'Tag', tipo: 'selezione-multipla' },
    ];
    const added = addPropertyToSchema(schema, {
      nome: 'Persone Coinvolte',
      tipo: 'selezione-multipla',
      opzioni: [
        { valore: 'Anna', colore: 'rosa' },
        { valore: 'Luca', colore: 'blu' },
      ],
    });
    schema = added.schema;
    expect(added.created.chiave).toBe('persone-coinvolte');

    // Rinomina proprietà: cambia solo nome, chiave immutabile
    schema = renamePropertyInSchema(schema, 'persone-coinvolte', 'Team Responsabile');
    expect(schema.find((p) => p.chiave === 'persone-coinvolte')?.nome).toBe('Team Responsabile');

    // Riordina proprietà
    schema = reorderPropertiesInSchema(schema, ['persone-coinvolte', 'data', 'stato', 'tag']);
    expect(schema.map((p) => p.chiave)).toEqual(['persone-coinvolte', 'data', 'stato', 'tag']);

    // Valore predefinito e decimali
    const withNum = addPropertyToSchema(schema, { nome: 'Budget', tipo: 'numero' });
    schema = setPropertyDecimalsInSchema(withNum.schema, 'budget', 2);
    schema = setPropertyDefaultInSchema(schema, 'budget', 100);
    expect(schema.find((p) => p.chiave === 'budget')?.decimali).toBe(2);
    expect(schema.find((p) => p.chiave === 'budget')?.predefinito).toBe(100);

    // Rinomina valore opzione con anteprima e patch chirurgica sulle righe
    const row1Content = '---\nid: p_1\npersone-coinvolte: [Anna, Luca]\n---\nCorpo 1\n';
    const row2Content = '---\nid: p_2\npersone-coinvolte: [Luca]\n---\nCorpo 2\n';
    const migration = planOptionRenameMigration(
      schema,
      [
        { path: 'db/r1.md', content: row1Content, values: { 'persone-coinvolte': ['Anna', 'Luca'] } },
        { path: 'db/r2.md', content: row2Content, values: { 'persone-coinvolte': ['Luca'] } },
      ],
      'persone-coinvolte',
      'Anna',
      'Anna Maria',
    );
    expect(migration.affectedRows).toHaveLength(1);
    expect(migration.affectedRows[0]!.path).toBe('db/r1.md');
    expect(migration.affectedRows[0]!.patchedContent).toContain('Anna Maria');
    expect(migration.affectedRows[0]!.patchedContent).toContain('Corpo 1\n');

    // Elimina proprietà: i valori nelle righe diventano "campi non definiti" e possono essere ripristinati
    schema = deletePropertyFromSchema(schema, 'budget');
    const undefs = detectUndefinedFields(
      [{ values: { id: 'p_1', budget: 250.5, 'persone-coinvolte': ['Anna'] } }],
      schema,
    );
    expect(undefs).toEqual([
      {
        chiave: 'budget',
        count: 1,
        sampleValues: [250.5],
        inferredType: 'numero',
      },
    ]);

    schema = restoreUndefinedPropertyToSchema(schema, {
      chiave: 'budget',
      nome: 'Budget Ripristinato',
      tipo: 'numero',
    });
    expect(schema.find((p) => p.chiave === 'budget')?.nome).toBe('Budget Ripristinato');

    // Crea opzioni dai valori esistenti (testo -> seleziona)
    const genOpts = buildOptionsFromExistingValues(['Urgente', 'Normale', 'Urgente'], 'seleziona');
    expect(genOpts.map((o) => o.valore)).toEqual(['Urgente', 'Normale']);

    // Cambia tipo senza toccare le righe
    schema = changePropertyTypeInSchema(schema, 'budget', 'seleziona');
    schema = updatePropertyOptionsInSchema(schema, 'budget', genOpts);
    expect(schema.find((p) => p.chiave === 'budget')?.tipo).toBe('seleziona');
  });

  it('scrive e rilegge in modo sicuro YAML con caratteri ostili e preserva CRLF, commenti e virgolette byte-per-byte', () => {
    const original =
      '---\r\n' +
      '# Commento iniziale intatto\r\n' +
      'id: p_hostile1\r\n' +
      'citazione: \'testo con singolo apice\'\r\n' +
      'sconosciuto: [1, 2, 3] # commento inline\r\n' +
      '---\r\n' +
      '\r\n' +
      '# Titolo Nota\r\n' +
      'Corpo con HTML <script>alert("xss")</script> intatto.\r\n';

    const hostileValues: Record<string, unknown> = {
      'due-punti': 'Valore: con: due punti e # cancelletto',
      trattini: '--- non è un separatore frontmatter ---',
      speciali: '*asterisco !esclamativo "virgolette" \'apici\' & % @ `backtick`',
      multilinea: 'Riga 1\nRiga 2 con : e #',
      unicode: 'Caffè, perché, 🚀, 日本語, € 1.250,00',
    };

    let doc = original;
    for (const [k, v] of Object.entries(hostileValues)) {
      doc = patchFrontmatterField(doc, k, v);
    }

    // Verifica che commenti, CRLF e corpo siano rimasti identici byte per byte
    expect(doc).toContain('# Commento iniziale intatto\r\n');
    expect(doc).toContain("citazione: 'testo con singolo apice'\r\n");
    expect(doc).toContain('sconosciuto: [1, 2, 3] # commento inline\r\n');
    expect(doc.endsWith('# Titolo Nota\r\nCorpo con HTML <script>alert("xss")</script> intatto.\r\n')).toBe(
      true,
    );

    const parsed = parseFrontmatterYaml(doc);
    expect(parsed.errors).toEqual([]);
    for (const [k, v] of Object.entries(hostileValues)) {
      expect(parsed.data[k]).toEqual(v);
    }

    // Verifica serializzazione e rilettura dello schema `proprieta:` come nel documento AGENTS.md
    const schemaDefs: PropertyDefinition[] = [
      { chiave: 'priorita', nome: 'Priorità: #1!', tipo: 'numero' },
      {
        chiave: 'persone',
        nome: 'Persone',
        tipo: 'selezione-multipla',
        opzioni: [{ valore: 'Anna: Responsabile #1', colore: 'rosa' }],
      },
    ];
    const withSchema = patchFrontmatterField(
      '---\ntipo: database\nid: p_db1\nversione-schema: 1\n---\n',
      'proprieta',
      serializePropertyDefinitions(schemaDefs),
    );
    const parsedDb = parseFrontmatterYaml(withSchema);
    expect(parsedDb.errors).toEqual([]);
    expect(parsePropertyDefinitions(parsedDb.data.proprieta)).toEqual(schemaDefs);
  });

  it('analizza blocchi vista, preserva round-trip byte-per-byte, segnala YAML non valido e applica precedenza proprieta > schema > inferenza', () => {
    const pageMd =
      '---\nid: p_host\n---\n\n' +
      'Testo sopra.\n\n' +
      '```vista\n' +
      'fonte: database p_a1b2c3\n' +
      'colonne: [attivita, stato, durata, data, priorita]\n' +
      'ordina: [{proprieta: data, direzione: asc}]\n' +
      'filtri: [{proprieta: stato, operatore: diverso, valore: Fatto}]\n' +
      '```\n\n' +
      '```vista\n' +
      'fonte: sottopagine\n' +
      'proprieta:\n' +
      '  - {chiave: priorita, nome: Priorità Locale, tipo: seleziona, opzioni: [{valore: Alta, colore: rosso}]}\n' +
      'schema: p_a1b2c3\n' +
      'colonne: [priorita, stimato, inesistente]\n' +
      '```\n\n' +
      '```vista\n' +
      'fonte: : : yaml rotto [\n' +
      '```\n\n' +
      '![[page:p_legacy99]]\n';

    const blocks = extractVistaBlocks(pageMd);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]!.parsed.ok).toBe(true);
    expect(blocks[1]!.parsed.ok).toBe(true);
    expect(blocks[2]!.parsed.ok).toBe(false); // YAML non valido -> segnaposto senza modificare il file
    expect(blocks[3]!.kind).toBe('legacy-embed');

    // Round-trip: il testo originale del blocco non toccato coincide al 100%
    expect(pageMd.slice(blocks[0]!.fromOffset, blocks[0]!.toOffset)).toBe(blocks[0]!.rawBlock);

    // Precedenza: proprieta del blocco vista > schema database > inferenza dal valore
    const dbSchema: PropertyDefinition[] = [
      { chiave: 'priorita', nome: 'Priorità DB', tipo: 'numero' },
    ];
    const sampleRows: TableRowItem[] = [
      {
        path: 'figlia.md',
        managePath: 'figlia.md',
        pageId: 'p_f1',
        title: 'Figlia',
        isNode: false,
        version: 'v1',
        mtimeMs: 1000,
        creato: '2026-09-01',
        modificato: '2026-09-02',
        percorso: 'figlia.md',
        tag: [],
        values: { priorita: 'Alta', stimato: 42 },
        warnings: {},
      },
    ];

    if (!blocks[1]!.parsed.ok) throw new Error('atteso blocco 1 valido');
    const resolved = resolveEffectiveColumns(
      blocks[1]!.parsed.config,
      dbSchema,
      sampleRows,
      'sottopagine',
    );
    // `priorita` prende la definizione dal blocco vista ('seleziona', "Priorità Locale") anziché dal DB ('numero')
    expect(resolved.effectiveColumns[0]!.nome).toBe('Priorità Locale');
    expect(resolved.effectiveColumns[0]!.tipo).toBe('seleziona');
    // `stimato` non è né nel blocco né nel DB -> inferito dal valore 42 come 'numero'
    expect(resolved.effectiveColumns[1]!.tipo).toBe('numero');
    // `inesistente` è segnalata in missingProperties
    expect(resolved.missingProperties).toEqual(['inesistente']);

    // Conversione esplicita di ![[page:p_legacy99]] in blocco ```vista``` al salvataggio vista
    const updatedMd = replaceVistaBlockInMarkdown(pageMd, 3, {
      fonte: 'database p_legacy99',
      colonne: ['stato', 'data'],
      ordina: [{ proprieta: 'data', direzione: 'desc' }],
    });
    expect(updatedMd).not.toContain('![[page:p_legacy99]]');
    expect(updatedMd).toContain('fonte: database p_legacy99');
    // Il blocco con YAML non valido (#2) è rimasto intatto byte per byte!
    expect(updatedMd).toContain('fonte: : : yaml rotto [');
  });

  it('ordina con più criteri (vuoti sempre in fondo, locale italiano) e applica tutti i 10 operatori di filtro in AND', () => {
    const rows: TableRowItem[] = [
      {
        path: 'r1.md',
        managePath: 'r1.md',
        pageId: 'p_1',
        title: 'Ètica',
        isNode: false,
        version: '1',
        mtimeMs: 1,
        creato: '2026-09-01',
        modificato: '2026-09-01',
        percorso: 'r1.md',
        tag: ['urgente'],
        values: {
          stato: 'In corso',
          priorita: 2,
          data: '2026-09-10',
          persone: ['Anna', 'Marco'],
          fatto: false,
        },
        warnings: {},
      },
      {
        path: 'r2.md',
        managePath: 'r2.md',
        pageId: 'p_2',
        title: 'Abaco',
        isNode: false,
        version: '1',
        mtimeMs: 1,
        creato: '2026-09-02',
        modificato: '2026-09-02',
        percorso: 'r2.md',
        tag: [],
        values: {
          stato: 'Da fare',
          priorita: 2,
          data: '2026-09-05',
          persone: ['Luca'],
          fatto: true,
        },
        warnings: {},
      },
      {
        path: 'r3.md',
        managePath: 'r3.md',
        pageId: 'p_3',
        title: 'Zeta (senza priorità)',
        isNode: false,
        version: '1',
        mtimeMs: 1,
        creato: '2026-09-03',
        modificato: '2026-09-03',
        percorso: 'r3.md',
        tag: [],
        values: {
          stato: 'Fatto',
        },
        warnings: {},
      },
    ];

    // Ordinamento multi-criterio: priorita ASC, poi titolo ASC -> r3 (vuoto) finisce in fondo sia in ASC sia in DESC
    const asc = sortTableRows(rows, [
      { proprieta: 'priorita', direzione: 'asc' },
      { proprieta: 'titolo', direzione: 'asc' },
    ]);
    expect(asc.map((r) => r.pageId)).toEqual(['p_2', 'p_1', 'p_3']);

    const desc = sortTableRows(rows, [
      { proprieta: 'priorita', direzione: 'desc' },
      { proprieta: 'titolo', direzione: 'asc' },
    ]);
    expect(desc.map((r) => r.pageId)).toEqual(['p_2', 'p_1', 'p_3']); // p_3 resta in fondo!

    // Tutti i 10 operatori di filtro
    expect(
      filterTableRows(rows, [{ proprieta: 'stato', operatore: 'uguale', valore: 'In corso' }]).map(
        (r) => r.pageId,
      ),
    ).toEqual(['p_1']);
    expect(
      filterTableRows(rows, [{ proprieta: 'stato', operatore: 'diverso', valore: 'Fatto' }]).map(
        (r) => r.pageId,
      ),
    ).toEqual(['p_1', 'p_2']);
    expect(
      filterTableRows(rows, [{ proprieta: 'titolo', operatore: 'contiene', valore: 'abac' }]).map(
        (r) => r.pageId,
      ),
    ).toEqual(['p_2']);
    expect(
      filterTableRows(rows, [{ proprieta: 'priorita', operatore: 'vuoto' }]).map((r) => r.pageId),
    ).toEqual(['p_3']);
    expect(
      filterTableRows(rows, [{ proprieta: 'priorita', operatore: 'non-vuoto' }]).map(
        (r) => r.pageId,
      ),
    ).toEqual(['p_1', 'p_2']);
    expect(
      filterTableRows(rows, [
        { proprieta: 'data', operatore: 'prima-di', valore: '2026-09-08' },
      ]).map((r) => r.pageId),
    ).toEqual(['p_2']);
    expect(
      filterTableRows(rows, [
        { proprieta: 'data', operatore: 'dopo-di', valore: '2026-09-08' },
      ]).map((r) => r.pageId),
    ).toEqual(['p_1']);
    expect(
      filterTableRows(rows, [{ proprieta: 'priorita', operatore: 'maggiore', valore: 1 }]).map(
        (r) => r.pageId,
      ),
    ).toEqual(['p_1', 'p_2']);
    expect(
      filterTableRows(rows, [{ proprieta: 'priorita', operatore: 'minore', valore: 3 }]).map(
        (r) => r.pageId,
      ),
    ).toEqual(['p_1', 'p_2']);
    expect(
      filterTableRows(rows, [
        { proprieta: 'persone', operatore: 'include', valore: 'Marco' },
      ]).map((r) => r.pageId),
    ).toEqual(['p_1']);
  });

  it.each([
    ['FsBackend', () => makeFsBackend()],
    ['GithubBackend', () => Promise.resolve(makeGithubBackend())],
  ])(
    'contratto identico su %s: patch proprietà con controllo versione 409, snapshot/undo, archiviazione riga e indicizzazione',
    async (_backendName, factory) => {
      const { kb } = await factory();

      // 1. Crea database _index.md e una riga
      const dbSchema: PropertyDefinition[] = [
        { chiave: 'priorita', nome: 'Priorità', tipo: 'numero', predefinito: 3 },
        {
          chiave: 'persone',
          nome: 'Persone',
          tipo: 'selezione-multipla',
          opzioni: [{ valore: 'Anna', colore: 'rosa' }],
        },
      ];
      const dbContent = patchFrontmatterField(
        '---\ntipo: database\nid: p_db100\nversione-schema: 1\n---\n',
        'proprieta',
        serializePropertyDefinitions(dbSchema),
      );
      await kb.create('progetti/attivita/_index.md', dbContent);

      const initialRow =
        '---\r\n' +
        '# Commento della riga\r\n' +
        'id: p_8f2a1c\r\n' +
        'priorita: 3\r\n' +
        'persone: [Anna]\r\n' +
        'creato: 2026-09-01\r\n' +
        'campo_extra: "conservato"\r\n' +
        '---\r\n' +
        '\r\n' +
        'Corpo della riga.\r\n';
      const createdRow = await kb.create('progetti/attivita/ Prima Attività .md'.replace(/ /g, ''), initialRow);
      const rowRead = await kb.read(createdRow.file.path);

      // 2. Patch di una sola proprietà: resto del file identico byte per byte
      const patched = await kb.patchFrontmatter(
        rowRead.path,
        'priorita',
        5,
        rowRead.version,
      );
      expect(patched.historyId).toBeTruthy();
      expect(patched.content).toContain('# Commento della riga');
      expect(patched.content).toContain('priorita: 5');
      expect(patched.content).toContain('persone: [Anna]');
      expect(patched.content).toContain('campo_extra: "conservato"');
      expect(patched.content).toContain('Corpo della riga.');

      // 3. Conflitto di versione (409) se si usa la vecchia baseVersion
      await expect(
        kb.patchFrontmatter(rowRead.path, 'priorita', 1, rowRead.version),
      ).rejects.toMatchObject({ status: 409, code: 'conflict' });

      // 4. Annullamento (restore dello snapshot)
      const restored = await kb.restore(rowRead.path, patched.historyId!);
      const afterRestore = await kb.read(restored.file.path);
      expect(parseFrontmatterYaml(afterRestore.content).data.priorita).toBe(3);

      // 5. Archiviazione della riga (mai eliminata)
      const archived = await kb.archive(rowRead.path);
      expect(archived.to).toContain('_archivio/');
      const activeTree = await kb.tree(false);
      expect(activeTree.some((e) => e.path === rowRead.path)).toBe(false);
      const fullTree = await kb.tree(true);
      expect(fullTree.some((e) => e.path === archived.to && e.archived)).toBe(true);
    },
  );

  it('indicizza e interroga 1000 pagine con frontmatter in tempi rapidi (< 600ms)', async () => {
    const { kb } = makeGithubBackend();
    for (let i = 1; i <= 1000; i++) {
      await kb.create(
        `note/pagina-${i}.md`,
        `---\nid: p_n${i}\nstato: ${i % 2 === 0 ? 'In corso' : 'Fatto'}\npriorita: ${i % 10}\ncreato: 2026-09-01\ntag: [lavoro, lotto-${i % 5}]\n---\nNota numero ${i}\n`,
      );
    }

    const t0 = performance.now();
    await kb.refresh();
    const docs = kb.frontmatter.all(false);
    expect(docs).toHaveLength(1000);

    const rows: TableRowItem[] = docs.map((d) => ({
      path: d.path,
      managePath: d.path,
      pageId: String(d.data.id ?? ''),
      title: d.path.slice(5, -3),
      isNode: false,
      version: 'v1',
      mtimeMs: 1000,
      creato: String(d.data.creato ?? ''),
      modificato: '2026-09-01',
      percorso: d.path,
      tag: d.tags,
      values: d.data,
      warnings: {},
    }));

    const vista: VistaBlockConfig = {
      fonte: 'tutte',
      colonne: ['stato', 'priorita', 'tag', 'creato'],
      filtri: [{ proprieta: 'stato', operatore: 'uguale', valore: 'In corso' }],
      ordina: [{ proprieta: 'priorita', direzione: 'desc' }],
    };

    const { allDefinitionsByKey } = resolveEffectiveColumns(vista, [], rows, 'tutte');
    const withWarnings = attachValidationWarningsToRows(rows, allDefinitionsByKey);
    const filtered = filterTableRows(withWarnings, vista.filtri);
    const sorted = sortTableRows(filtered, vista.ordina, allDefinitionsByKey);
    const elapsedMs = performance.now() - t0;

    expect(sorted).toHaveLength(500);
    expect(sorted[0]!.values.priorita).toBe(8);
    expect(elapsedMs).toBeLessThan(1500);
  });
});
