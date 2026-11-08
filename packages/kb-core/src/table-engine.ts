import type {
  EffectiveColumnMeta,
  PropertyDefinition,
  TableRowItem,
  VistaBlockConfig,
  VistaFilter,
  VistaSort,
} from '@brain/shared';
import {
  COMPUTED_COLUMN_KEYS,
  inferPropertyTypeFromValue,
  parseDateOrInterval,
  RESERVED_PROPERTY_KEYS,
  validatePropertyValue,
} from './schema.js';

const italianCollator = new Intl.Collator('it', {
  sensitivity: 'base',
  numeric: true,
});

export function isRowValueEmpty(val: unknown): boolean {
  if (val === undefined || val === null || val === '') return true;
  if (Array.isArray(val)) return val.length === 0;
  return false;
}

export function getRowCellValue(row: TableRowItem, propKey: string): unknown {
  const clean = propKey.trim();
  const lower = clean.toLowerCase();
  if (lower === 'titolo' || lower === 'nome' || lower === 'attivita') {
    if (row.values[clean] !== undefined) return row.values[clean];
    return row.title;
  }
  if (lower === 'creato' || lower === 'creato-il') {
    return row.creato ?? row.values.creato ?? row.values['creato-il'] ?? null;
  }
  if (lower === 'modificato') {
    return row.modificato;
  }
  if (lower === 'percorso') {
    return row.percorso;
  }
  if (lower === 'tag') {
    return row.values.tag ?? row.tag;
  }
  if (Object.prototype.hasOwnProperty.call(row.values, clean)) {
    return row.values[clean];
  }
  for (const [k, v] of Object.entries(row.values)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function builtInComputedCol(key: string, width?: number): EffectiveColumnMeta | null {
  const lower = key.toLowerCase();
  if (lower === 'creato' || lower === 'creato-il') {
    return {
      chiave: 'creato',
      nome: 'Creato',
      tipo: 'creato',
      computed: true,
      ...(width ? { width } : {}),
    };
  }
  if (lower === 'modificato') {
    return {
      chiave: 'modificato',
      nome: 'Modificato',
      tipo: 'modificato',
      computed: true,
      ...(width ? { width } : {}),
    };
  }
  if (lower === 'percorso') {
    return {
      chiave: 'percorso',
      nome: 'Percorso',
      tipo: 'testo',
      computed: true,
      ...(width ? { width } : {}),
    };
  }
  if (lower === 'tag') {
    return {
      chiave: 'tag',
      nome: 'Tag',
      tipo: 'selezione-multipla',
      computed: true,
      ...(width ? { width } : {}),
    };
  }
  return null;
}

/**
 * Risolve le colonne effettive e la definizione di ogni proprietà secondo la regola di precedenza (punto 1b):
 *   1. `vista.proprieta` (definizioni locali al blocco vista)
 *   2. `dbSchema` (schema del database indicato in `vista.schema` o del database `fonte: database <id>`)
 *   3. Inferenza dal valore presente nelle righe (`data ISO -> data`, `numero -> numero`, `true/false -> casella`, `lista -> selezione-multipla`, `altro -> testo`).
 */
export function resolveEffectiveColumns(
  vista: VistaBlockConfig,
  dbSchema: readonly PropertyDefinition[],
  rows: readonly TableRowItem[],
  sourceType: 'database' | 'sottopagine' | 'discendenti' | 'tutte',
): {
  effectiveColumns: EffectiveColumnMeta[];
  allDefinitionsByKey: Map<string, EffectiveColumnMeta>;
  missingProperties: string[];
} {
  const vistaPropsByLower = new Map<string, PropertyDefinition>();
  for (const p of vista.proprieta ?? []) {
    vistaPropsByLower.set(p.chiave.toLowerCase(), p);
  }

  const dbPropsByLower = new Map<string, PropertyDefinition>();
  for (const p of dbSchema) {
    dbPropsByLower.set(p.chiave.toLowerCase(), p);
  }

  // Raccoglie tutte le chiavi effettivamente presenti nei frontmatter delle righe per l'inferenza
  const rowSampleByLower = new Map<string, { originalKey: string; sample: unknown }>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.values)) {
      const low = k.toLowerCase();
      if (RESERVED_PROPERTY_KEYS.has(low) && low !== 'creato') continue;
      if (isRowValueEmpty(v)) continue;
      if (!rowSampleByLower.has(low)) {
        rowSampleByLower.set(low, { originalKey: k, sample: v });
      }
    }
  }

  const widthMap = new Map<string, number>();
  if (vista.larghezze) {
    for (const [k, w] of Object.entries(vista.larghezze)) {
      if (typeof w === 'number' && w > 30) widthMap.set(k.toLowerCase(), w);
    }
  }

  const resolveKeyDefinition = (rawKey: string, inlineWidth?: number): {
    col: EffectiveColumnMeta;
    missing: boolean;
  } => {
    const clean = rawKey.trim();
    const low = clean.toLowerCase();
    const width = inlineWidth ?? widthMap.get(low);

    // 1. Precedenza massima: `proprieta` nel blocco vista
    const fromVista = vistaPropsByLower.get(low);
    if (fromVista) {
      return {
        col: { ...fromVista, ...(width ? { width } : {}) },
        missing: false,
      };
    }

    // 2. Secondo livello: `schema` del database
    const fromDb = dbPropsByLower.get(low);
    if (fromDb) {
      return {
        col: { ...fromDb, ...(width ? { width } : {}) },
        missing: false,
      };
    }

    // 3. Colonne calcolate built-in (tag, creato, modificato, percorso)
    const computed = builtInComputedCol(low, width);
    if (computed) {
      return { col: computed, missing: false };
    }

    // 4. Inferenza dai valori presenti nelle righe
    const sampleHit = rowSampleByLower.get(low);
    if (sampleHit) {
      const inferredType = inferPropertyTypeFromValue(sampleHit.originalKey, sampleHit.sample);
      return {
        col: {
          chiave: sampleHit.originalKey,
          nome: sampleHit.originalKey.charAt(0).toUpperCase() + sampleHit.originalKey.slice(1),
          tipo: inferredType,
          ...(width ? { width } : {}),
        },
        missing: false,
      };
    }

    // Proprietà richiesta in `colonne:` ma non presente né nello schema né nelle righe
    return {
      col: {
        chiave: clean,
        nome: clean,
        tipo: 'testo',
        missingFromSchema: true,
        ...(width ? { width } : {}),
      },
      missing: true,
    };
  };

  const effectiveColumns: EffectiveColumnMeta[] = [];
  const allDefinitionsByKey = new Map<string, EffectiveColumnMeta>();
  const missingProperties: string[] = [];
  const addedLower = new Set<string>();

  if (vista.colonne && vista.colonne.length > 0) {
    for (const spec of vista.colonne) {
      const key = typeof spec === 'string' ? spec.trim() : spec.chiave.trim();
      const inlineW = typeof spec === 'object' ? spec.larghezza : undefined;
      const low = key.toLowerCase();
      // Il titolo è sempre la prima colonna fissa, quindi se `colonne:` elenca `titolo` o `attivita` (quando non è una proprietà separata), non duplichiamo la colonna titolo
      if (
        low === 'titolo' ||
        (low === 'attivita' &&
          !vistaPropsByLower.has('attivita') &&
          !dbPropsByLower.has('attivita') &&
          !rowSampleByLower.has('attivita'))
      ) {
        continue;
      }
      if (addedLower.has(low)) continue;
      addedLower.add(low);

      const { col, missing } = resolveKeyDefinition(key, inlineW);
      effectiveColumns.push(col);
      allDefinitionsByKey.set(col.chiave.toLowerCase(), col);
      if (missing) missingProperties.push(key);
    }
  } else if (sourceType === 'database' || dbSchema.length > 0) {
    // Ordine predefinito delle colonne = ordine della lista `proprieta` nel database (o nel blocco vista)
    const baseList =
      vista.proprieta && vista.proprieta.length > 0 ? vista.proprieta : dbSchema;
    for (const p of baseList) {
      const low = p.chiave.toLowerCase();
      if (addedLower.has(low)) continue;
      addedLower.add(low);
      const { col } = resolveKeyDefinition(p.chiave);
      effectiveColumns.push(col);
      allDefinitionsByKey.set(low, col);
    }
  } else if (vista.proprieta && vista.proprieta.length > 0) {
    for (const p of vista.proprieta) {
      const low = p.chiave.toLowerCase();
      if (addedLower.has(low)) continue;
      addedLower.add(low);
      const { col } = resolveKeyDefinition(p.chiave);
      effectiveColumns.push(col);
      allDefinitionsByKey.set(low, col);
    }
  } else {
    // Default per "Indice di pagine": tag e creato (il titolo è sempre la prima colonna)
    for (const k of ['tag', 'creato']) {
      addedLower.add(k);
      const { col } = resolveKeyDefinition(k);
      effectiveColumns.push(col);
      allDefinitionsByKey.set(k, col);
    }
  }

  // Registra anche tutte le altre proprietà note (per filtri/ordinamenti su colonne non visibili)
  for (const p of dbSchema) {
    const low = p.chiave.toLowerCase();
    if (!allDefinitionsByKey.has(low)) {
      allDefinitionsByKey.set(low, resolveKeyDefinition(p.chiave).col);
    }
  }
  for (const p of vista.proprieta ?? []) {
    const low = p.chiave.toLowerCase();
    if (!allDefinitionsByKey.has(low)) {
      allDefinitionsByKey.set(low, resolveKeyDefinition(p.chiave).col);
    }
  }
  for (const k of COMPUTED_COLUMN_KEYS) {
    if (!allDefinitionsByKey.has(k)) {
      const c = builtInComputedCol(k);
      if (c) allDefinitionsByKey.set(k, c);
    }
  }
  for (const [low, sampleHit] of rowSampleByLower.entries()) {
    if (!allDefinitionsByKey.has(low)) {
      allDefinitionsByKey.set(low, resolveKeyDefinition(sampleHit.originalKey).col);
    }
  }

  return { effectiveColumns, allDefinitionsByKey, missingProperties };
}

/**
 * Calcola gli avvisi di validazione tollerante per ciascuna riga senza mai alterare i valori.
 */
export function attachValidationWarningsToRows(
  rows: readonly TableRowItem[],
  allDefinitionsByKey: ReadonlyMap<string, EffectiveColumnMeta>,
): TableRowItem[] {
  return rows.map((row) => {
    const warnings: Record<string, string> = {};
    for (const [lowKey, def] of allDefinitionsByKey.entries()) {
      if (def.computed && lowKey !== 'creato') continue;
      const val = getRowCellValue(row, def.chiave);
      const strictOptions =
        (def.tipo === 'seleziona' || def.tipo === 'selezione-multipla' || def.tipo === 'stato') &&
        def.opzioni !== undefined &&
        (def.tipo !== 'selezione-multipla' || def.chiave.toLowerCase() !== 'tag' || def.opzioni.length > 0);
      const res = validatePropertyValue(def, val, { strictOptions });
      if (!res.valid && res.warning) {
        warnings[def.chiave] = res.warning;
      }
    }
    return {
      ...row,
      warnings,
    };
  });
}

// ---------------------------------------------------------------------------
// Filtri (lista in AND con tutti i 10 operatori)
// ---------------------------------------------------------------------------

function extractIsoComparableForDate(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const parsed = parseDateOrInterval(val);
  if (parsed) return parsed.start.isoComparable.slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(val.trim());
  return m ? m[1]! : null;
}

export function matchesSingleFilter(row: TableRowItem, filter: VistaFilter): boolean {
  const cellVal = getRowCellValue(row, filter.proprieta);
  const op = filter.operatore;
  const filterVal = filter.valore;

  switch (op) {
    case 'vuoto':
      return isRowValueEmpty(cellVal);

    case 'non-vuoto':
      return !isRowValueEmpty(cellVal);

    case 'uguale': {
      if (isRowValueEmpty(cellVal)) return isRowValueEmpty(filterVal);
      if (typeof cellVal === 'boolean') {
        const targetBool =
          typeof filterVal === 'boolean'
            ? filterVal
            : String(filterVal).trim().toLowerCase() === 'true';
        return cellVal === targetBool;
      }
      if (typeof cellVal === 'number' && typeof filterVal === 'number') {
        return cellVal === filterVal;
      }
      if (typeof cellVal === 'number' && typeof filterVal === 'string' && filterVal.trim() !== '') {
        const num = Number(filterVal);
        if (Number.isFinite(num)) return cellVal === num;
      }
      return (
        String(cellVal).trim().toLowerCase() ===
        String(filterVal ?? '').trim().toLowerCase()
      );
    }

    case 'diverso':
      return !matchesSingleFilter(row, { ...filter, operatore: 'uguale' });

    case 'contiene': {
      if (isRowValueEmpty(cellVal)) return false;
      const needle = String(filterVal ?? '').trim().toLowerCase();
      if (!needle) return true;
      if (Array.isArray(cellVal)) {
        return cellVal.some((item) => String(item).toLowerCase().includes(needle));
      }
      return String(cellVal).toLowerCase().includes(needle);
    }

    case 'include': {
      if (isRowValueEmpty(cellVal)) return false;
      const targets = Array.isArray(filterVal)
        ? filterVal.map((x) => String(x).trim().toLowerCase())
        : [String(filterVal ?? '').trim().toLowerCase()];
      if (Array.isArray(cellVal)) {
        const setLower = new Set(cellVal.map((x) => String(x).trim().toLowerCase()));
        return targets.some((t) => setLower.has(t));
      }
      const singleLower = String(cellVal).trim().toLowerCase();
      return targets.includes(singleLower);
    }

    case 'prima-di': {
      const rowDate = extractIsoComparableForDate(cellVal);
      const targetDate = extractIsoComparableForDate(filterVal);
      if (!rowDate || !targetDate) return false;
      return rowDate < targetDate;
    }

    case 'dopo-di': {
      const rowDate = extractIsoComparableForDate(cellVal);
      const targetDate = extractIsoComparableForDate(filterVal);
      if (!rowDate || !targetDate) return false;
      return rowDate > targetDate;
    }

    case 'maggiore': {
      const rowNum = typeof cellVal === 'number' ? cellVal : Number(cellVal);
      const targetNum = typeof filterVal === 'number' ? filterVal : Number(filterVal);
      if (!Number.isFinite(rowNum) || !Number.isFinite(targetNum)) return false;
      return rowNum > targetNum;
    }

    case 'minore': {
      const rowNum = typeof cellVal === 'number' ? cellVal : Number(cellVal);
      const targetNum = typeof filterVal === 'number' ? filterVal : Number(filterVal);
      if (!Number.isFinite(rowNum) || !Number.isFinite(targetNum)) return false;
      return rowNum < targetNum;
    }
  }
}

export function filterTableRows(
  rows: readonly TableRowItem[],
  filters: readonly VistaFilter[] | undefined,
): TableRowItem[] {
  if (!filters || filters.length === 0) return [...rows];
  return rows.filter((row) => filters.every((f) => matchesSingleFilter(row, f)));
}

// ---------------------------------------------------------------------------
// Ordinamento (più criteri, vuoti SEMPRE in fondo, locale italiano)
// ---------------------------------------------------------------------------

function compareNonEmptyValues(
  a: unknown,
  b: unknown,
  colDef?: EffectiveColumnMeta,
): number {
  const tipo = colDef?.tipo;

  if (tipo === 'numero' || (typeof a === 'number' && typeof b === 'number')) {
    const na = typeof a === 'number' ? a : Number(a);
    const nb = typeof b === 'number' ? b : Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      return na - nb;
    }
  }

  if (tipo === 'data' || tipo === 'creato' || tipo === 'modificato') {
    const da = parseDateOrInterval(a)?.start.isoComparable ?? String(a);
    const db = parseDateOrInterval(b)?.start.isoComparable ?? String(b);
    if (da !== db) return da < db ? -1 : 1;
    return 0;
  }

  if (tipo === 'casella' || (typeof a === 'boolean' && typeof b === 'boolean')) {
    const ba = Boolean(a);
    const bb = Boolean(b);
    return ba === bb ? 0 : ba ? 1 : -1;
  }

  const sa = Array.isArray(a) ? a.join(', ') : String(a);
  const sb = Array.isArray(b) ? b.join(', ') : String(b);
  return italianCollator.compare(sa, sb);
}

/**
 * Ordina le righe secondo una lista di criteri `VistaSort`.
 * I valori vuoti finiscono SEMPRE in fondo, sia in ordine crescente (`asc`) sia decrescente (`desc`).
 */
export function sortTableRows(
  rows: readonly TableRowItem[],
  sorts: readonly VistaSort[] | undefined,
  allDefinitionsByKey?: ReadonlyMap<string, EffectiveColumnMeta>,
): TableRowItem[] {
  if (!sorts || sorts.length === 0) {
    return [...rows].sort((a, b) => italianCollator.compare(a.title, b.title));
  }

  return [...rows].sort((rowA, rowB) => {
    for (const s of sorts) {
      const valA = getRowCellValue(rowA, s.proprieta);
      const valB = getRowCellValue(rowB, s.proprieta);
      const emptyA = isRowValueEmpty(valA);
      const emptyB = isRowValueEmpty(valB);

      if (emptyA && emptyB) continue;
      // Regola: vuoti sempre in fondo!
      if (emptyA) return 1;
      if (emptyB) return -1;

      const colDef = allDefinitionsByKey?.get(s.proprieta.toLowerCase());
      const cmp = compareNonEmptyValues(valA, valB, colDef);
      if (cmp !== 0) {
        return s.direzione === 'desc' ? -cmp : cmp;
      }
    }
    return italianCollator.compare(rowA.title, rowB.title);
  });
}
