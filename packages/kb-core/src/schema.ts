import type {
  PropertyColor,
  PropertyDefinition,
  PropertyOption,
  PropertyType,
  StatusGroup,
  UndefinedFieldInfo,
  ValueValidationResult,
} from '@brain/shared';
import { badRequest } from './errors.js';
import { patchFrontmatterField } from './frontmatter-patch.js';

export const SCHEMA_VERSION = 1;
export const MAX_PROPERTY_NAME_LENGTH = 60;
export const MAX_PROPERTIES_PER_TABLE = 50;
export const MAX_OPTIONS_PER_PROPERTY = 100;
export const MAX_PROPERTY_VALUE_LENGTH = 200;

export const PROPERTY_COLORS: readonly PropertyColor[] = [
  'grigio',
  'marrone',
  'arancione',
  'giallo',
  'verde',
  'blu',
  'viola',
  'rosa',
  'rosso',
] as const;

export const STATUS_GROUPS: readonly StatusGroup[] = [
  'da-fare',
  'in-corso',
  'completato',
] as const;

export const PROPERTY_TYPES: readonly PropertyType[] = [
  'testo',
  'numero',
  'seleziona',
  'selezione-multipla',
  'stato',
  'data',
  'casella',
  'url',
  'email',
  'telefono',
  'creato',
  'modificato',
] as const;

/** Chiavi riservate che l'utente non può usare per proprietà personalizzate. */
export const RESERVED_PROPERTY_KEYS = new Set<string>([
  'id',
  'icona',
  'copertina',
  'creato',
  'modificato',
  'titolo',
  'tipo',
  'proprieta',
  'versione-schema',
]);

/** Colonne calcolate sempre disponibili nelle viste. */
export const COMPUTED_COLUMN_KEYS = new Set<string>([
  'tag',
  'creato',
  'modificato',
  'percorso',
]);

const ITALIAN_MONTHS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
] as const;

/** Normalizza eventuali alias legacy del tipo verso il nome canonico. */
export function normalizePropertyType(raw: unknown): PropertyType | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().toLowerCase();
  if (clean === 'selezione') return 'seleziona';
  if (clean === 'selezione_multipla' || clean === 'multipla') return 'selezione-multipla';
  if (clean === 'creato-il') return 'creato';
  if ((PROPERTY_TYPES as readonly string[]).includes(clean)) {
    return clean as PropertyType;
  }
  return null;
}

export function normalizePropertyColor(raw: unknown, fallback: PropertyColor = 'grigio'): PropertyColor {
  if (typeof raw === 'string') {
    const clean = raw.trim().toLowerCase() as PropertyColor;
    if ((PROPERTY_COLORS as readonly string[]).includes(clean)) {
      return clean;
    }
  }
  return fallback;
}

export function normalizeStatusGroup(raw: unknown, fallback: StatusGroup = 'da-fare'): StatusGroup {
  if (typeof raw === 'string') {
    const clean = raw.trim().toLowerCase() as StatusGroup;
    if ((STATUS_GROUPS as readonly string[]).includes(clean)) {
      return clean;
    }
  }
  return fallback;
}

/**
 * Genera lo slug stabile dalla label della proprietà:
 * minuscolo, senza accenti, spazi e punteggiatura convertiti in "-",
 * unico nella tabella (con suffisso -2, -3... in caso di collisione).
 */
export function slugifyBaseKey(nome: string): string {
  const deaccented = nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const slug = deaccented
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'proprieta';
}

export function validatePropertyName(nome: unknown): string {
  if (typeof nome !== 'string') {
    throw badRequest('Il nome della proprietà è obbligatorio.');
  }
  const trimmed = nome.trim();
  if (!trimmed) {
    throw badRequest('Il nome della proprietà non può essere vuoto.');
  }
  if (trimmed.length > MAX_PROPERTY_NAME_LENGTH) {
    throw badRequest(
      `Il nome della proprietà non può superare ${MAX_PROPERTY_NAME_LENGTH} caratteri.`,
    );
  }
  return trimmed;
}

export function generateUniquePropertyKey(
  nome: string,
  tipo: PropertyType,
  existingKeys: Iterable<string>,
): string {
  const cleanName = validatePropertyName(nome);
  const baseSlug = slugifyBaseKey(cleanName);

  if (RESERVED_PROPERTY_KEYS.has(baseSlug)) {
    throw badRequest(
      `La chiave "${baseSlug}" è riservata dal sistema e non può essere usata come proprietà.`,
    );
  }

  const used = new Set<string>();
  for (const k of existingKeys) {
    used.add(k.toLowerCase());
  }

  if (baseSlug === 'tag') {
    if (tipo !== 'selezione-multipla') {
      throw badRequest(
        'La chiave "tag" è ammessa solo con il tipo "selezione-multipla" (alimenta i tag della KB).',
      );
    }
    if (used.has('tag')) {
      throw badRequest('La proprietà "tag" esiste già in questa tabella.');
    }
    return 'tag';
  }

  if (!used.has(baseSlug)) {
    return baseSlug;
  }

  let suffix = 2;
  while (used.has(`${baseSlug}-${suffix}`) || RESERVED_PROPERTY_KEYS.has(`${baseSlug}-${suffix}`)) {
    suffix++;
  }
  return `${baseSlug}-${suffix}`;
}

export function validatePropertyKeyAndType(chiave: string, tipo: PropertyType): void {
  const cleanKey = chiave.trim().toLowerCase();
  if (!cleanKey) {
    throw badRequest('Chiave proprietà vuota.');
  }
  if (RESERVED_PROPERTY_KEYS.has(cleanKey)) {
    throw badRequest(`La chiave "${cleanKey}" è riservata dal sistema.`);
  }
  if (cleanKey === 'tag' && tipo !== 'selezione-multipla') {
    throw badRequest('La chiave "tag" è ammessa solo come "selezione-multipla".');
  }
}

export function validateOptionsList(
  opzioni: readonly PropertyOption[] | undefined,
  tipo: PropertyType,
): PropertyOption[] | undefined {
  if (tipo !== 'seleziona' && tipo !== 'selezione-multipla' && tipo !== 'stato') {
    return undefined;
  }
  const rawList = opzioni ?? [];
  if (rawList.length > MAX_OPTIONS_PER_PROPERTY) {
    throw badRequest(
      `Una proprietà può avere al massimo ${MAX_OPTIONS_PER_PROPERTY} opzioni.`,
    );
  }
  const seen = new Set<string>();
  const out: PropertyOption[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i]!;
    const val = typeof item.valore === 'string' ? item.valore.trim() : '';
    if (!val) {
      throw badRequest('Il valore di un\'opzione non può essere vuoto.');
    }
    if (val.length > MAX_PROPERTY_VALUE_LENGTH) {
      throw badRequest(
        `Il valore di un'opzione non può superare ${MAX_PROPERTY_VALUE_LENGTH} caratteri.`,
      );
    }
    if (seen.has(val)) {
      continue;
    }
    seen.add(val);
    const fallbackColor = PROPERTY_COLORS[i % PROPERTY_COLORS.length]!;
    const colore = normalizePropertyColor(item.colore, fallbackColor);
    if (tipo === 'stato') {
      const defaultGroup: StatusGroup =
        i === 0 ? 'da-fare' : i === rawList.length - 1 ? 'completato' : 'in-corso';
      out.push({
        valore: val,
        colore,
        gruppo: normalizeStatusGroup(item.gruppo, defaultGroup),
      });
    } else {
      out.push({ valore: val, colore });
    }
  }
  return out;
}

export function defaultStatusOptions(): PropertyOption[] {
  return [
    { valore: 'Da fare', colore: 'grigio', gruppo: 'da-fare' },
    { valore: 'In corso', colore: 'blu', gruppo: 'in-corso' },
    { valore: 'Fatto', colore: 'verde', gruppo: 'completato' },
  ];
}

export function createDefaultDatabaseSchema(): PropertyDefinition[] {
  // Nessuna colonna predefinita a meno del nome della nota (il titolo è gestito come prima colonna fissa)
  return [];
}

/** Parsing tollerante di uno schema `proprieta:` dal frontmatter YAML o dal blocco vista. */
export function parsePropertyDefinitions(raw: unknown): PropertyDefinition[] {
  if (!Array.isArray(raw)) return [];
  const out: PropertyDefinition[] = [];
  const seenKeys = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const rawKey = typeof rec.chiave === 'string' ? rec.chiave.trim() : '';
    if (!rawKey || seenKeys.has(rawKey.toLowerCase())) continue;
    const tipo = normalizePropertyType(rec.tipo) ?? 'testo';
    const nome =
      typeof rec.nome === 'string' && rec.nome.trim() !== ''
        ? rec.nome.trim().slice(0, MAX_PROPERTY_NAME_LENGTH)
        : rawKey;

    let opzioni: PropertyOption[] | undefined;
    if (
      (tipo === 'seleziona' || tipo === 'selezione-multipla' || tipo === 'stato') &&
      Array.isArray(rec.opzioni)
    ) {
      opzioni = [];
      for (let i = 0; i < rec.opzioni.length && opzioni.length < MAX_OPTIONS_PER_PROPERTY; i++) {
        const opt = rec.opzioni[i];
        if (typeof opt === 'string' && opt.trim()) {
          opzioni.push({
            valore: opt.trim(),
            colore: PROPERTY_COLORS[i % PROPERTY_COLORS.length]!,
            ...(tipo === 'stato' ? { gruppo: 'da-fare' as const } : {}),
          });
        } else if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
          const o = opt as Record<string, unknown>;
          const val = typeof o.valore === 'string' ? o.valore.trim() : '';
          if (!val) continue;
          const colore = normalizePropertyColor(
            o.colore,
            PROPERTY_COLORS[i % PROPERTY_COLORS.length]!,
          );
          if (tipo === 'stato') {
            opzioni.push({
              valore: val,
              colore,
              gruppo: normalizeStatusGroup(o.gruppo, 'da-fare'),
            });
          } else {
            opzioni.push({ valore: val, colore });
          }
        }
      }
    } else if (tipo === 'stato') {
      opzioni = defaultStatusOptions();
    }

    const decimali =
      typeof rec.decimali === 'number' &&
      Number.isInteger(rec.decimali) &&
      rec.decimali >= 0 &&
      rec.decimali <= 10
        ? rec.decimali
        : undefined;

    seenKeys.add(rawKey.toLowerCase());
    out.push({
      chiave: rawKey,
      nome,
      tipo,
      ...(opzioni !== undefined ? { opzioni } : {}),
      ...(rec.predefinito !== undefined ? { predefinito: rec.predefinito } : {}),
      ...(decimali !== undefined ? { decimali } : {}),
    });
    if (out.length >= MAX_PROPERTIES_PER_TABLE) break;
  }

  return out;
}

/** Serializza una lista di `PropertyDefinition` in oggetti puri pronti per YAML. */
export function serializePropertyDefinitions(defs: readonly PropertyDefinition[]): Array<Record<string, unknown>> {
  return defs.map((d) => {
    const obj: Record<string, unknown> = {
      chiave: d.chiave,
      nome: d.nome,
      tipo: d.tipo,
    };
    if (
      (d.tipo === 'seleziona' || d.tipo === 'selezione-multipla' || d.tipo === 'stato') &&
      d.opzioni &&
      d.opzioni.length > 0
    ) {
      obj.opzioni = d.opzioni.map((o) => {
        if (d.tipo === 'stato') {
          return {
            valore: o.valore,
            colore: o.colore,
            gruppo: o.gruppo ?? 'da-fare',
          };
        }
        return {
          valore: o.valore,
          colore: o.colore,
        };
      });
    }
    if (d.predefinito !== undefined && d.predefinito !== null && d.predefinito !== '') {
      obj.predefinito = d.predefinito;
    }
    if (d.tipo === 'numero' && typeof d.decimali === 'number') {
      obj.decimali = d.decimali;
    }
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Parsing, validazione e formattazione in italiano delle Date
// ---------------------------------------------------------------------------

export interface ParsedSingleDate {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  isoComparable: string;
}

export interface ParsedDateValue {
  start: ParsedSingleDate;
  end?: ParsedSingleDate;
}

const SINGLE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

export function parseSingleIsoDate(raw: string): ParsedSingleDate | null {
  const m = SINGLE_DATE_RE.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Verifica giorni reali del mese (inclusi anni bisestili)
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  let hour: number | undefined;
  let minute: number | undefined;
  if (m[4] !== undefined && m[5] !== undefined) {
    hour = Number(m[4]);
    minute = Number(m[5]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  }

  const timePart =
    hour !== undefined && minute !== undefined
      ? `T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      : '';
  return {
    year,
    month,
    day,
    ...(hour !== undefined ? { hour } : {}),
    ...(minute !== undefined ? { minute } : {}),
    isoComparable: `${m[1]}-${m[2]}-${m[3]}${timePart}`,
  };
}

export function parseDateOrInterval(raw: unknown): ParsedDateValue | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Supporta "/" come separatore canonico di intervallo (e ".." in lettura tollerante)
  const slashIdx = trimmed.indexOf('/');
  const dotIdx = slashIdx === -1 ? trimmed.indexOf('..') : -1;
  if (slashIdx !== -1 || dotIdx !== -1) {
    const left = slashIdx !== -1 ? trimmed.slice(0, slashIdx) : trimmed.slice(0, dotIdx);
    const right = slashIdx !== -1 ? trimmed.slice(slashIdx + 1) : trimmed.slice(dotIdx + 2);
    if (right.includes('/') || right.includes('..')) return null;
    const start = parseSingleIsoDate(left);
    const end = parseSingleIsoDate(right);
    if (!start || !end) return null;
    if (start.isoComparable > end.isoComparable) return null;
    return { start, end };
  }

  const single = parseSingleIsoDate(trimmed);
  if (!single) return null;
  return { start: single };
}

function formatSingleDateIt(d: ParsedSingleDate): string {
  const monthName = ITALIAN_MONTHS[d.month - 1] ?? '';
  const datePart = `${d.day} ${monthName} ${d.year}`;
  if (d.hour !== undefined && d.minute !== undefined) {
    return `${datePart}, ${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}`;
  }
  return datePart;
}

/**
 * Formatta una data o intervallo ISO in italiano:
 * "2026-09-01/2026-11-30" -> "1 settembre 2026 → 30 novembre 2026"
 */
export function formatItalianDate(raw: unknown): string {
  const parsed = parseDateOrInterval(raw);
  if (!parsed) return typeof raw === 'string' ? raw : String(raw ?? '');
  const startStr = formatSingleDateIt(parsed.start);
  if (parsed.end) {
    return `${startStr} → ${formatSingleDateIt(parsed.end)}`;
  }
  return startStr;
}

// ---------------------------------------------------------------------------
// Inferenza del tipo dal valore (per viste senza schema e pagine libere)
// ---------------------------------------------------------------------------

export function inferPropertyTypeFromValue(key: string, value: unknown): PropertyType {
  const cleanKey = key.trim().toLowerCase();
  if (cleanKey === 'creato' || cleanKey === 'creato-il') return 'creato';
  if (cleanKey === 'modificato') return 'modificato';
  if (cleanKey === 'tag') return 'selezione-multipla';

  if (typeof value === 'boolean') return 'casella';
  if (typeof value === 'number' && Number.isFinite(value)) return 'numero';
  if (Array.isArray(value)) return 'selezione-multipla';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (parseDateOrInterval(trimmed) !== null) return 'data';
  }
  return 'testo';
}

// ---------------------------------------------------------------------------
// Validazione e Lettura TOLLERANTE dei valori (MAI riscrivere/cancellare file)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{5,30}$/;

export function isValidUrlValue(val: string): boolean {
  try {
    const u = new URL(val.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidEmailValue(val: string): boolean {
  return EMAIL_RE.test(val.trim());
}

export function isValidPhoneValue(val: string): boolean {
  const t = val.trim();
  if (!PHONE_RE.test(t)) return false;
  const digits = t.match(/\d/g)?.length ?? 0;
  return digits >= 5 && digits <= 20;
}

export function formatNumberValue(val: number, decimali?: number): string {
  if (typeof decimali === 'number' && decimali >= 0 && decimali <= 10) {
    return val.toLocaleString('it-IT', {
      minimumFractionDigits: decimali,
      maximumFractionDigits: decimali,
    });
  }
  return val.toLocaleString('it-IT');
}

export function stringifyRawValueForDisplay(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) return raw.map((x) => stringifyRawValueForDisplay(x)).join(', ');
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/**
 * Valida un valore rispetto alla definizione della proprietà in modo TOLLERANTE:
 * se il valore non è valido per il tipo, è fuori dalle opzioni o ha il formato di un altro tipo,
 * restituisce `valid: false` e un `warning` descrittivo senza modificare né cancellare il valore.
 */
export function validatePropertyValue(
  def: Pick<PropertyDefinition, 'tipo' | 'opzioni' | 'decimali'>,
  rawValue: unknown,
  opts?: { strictOptions?: boolean },
): ValueValidationResult {
  if (
    rawValue === undefined ||
    rawValue === null ||
    rawValue === '' ||
    (Array.isArray(rawValue) && rawValue.length === 0)
  ) {
    return { valid: true, empty: true, formatted: '' };
  }

  const tipo = normalizePropertyType(def.tipo) ?? 'testo';
  const strictOptions = opts?.strictOptions ?? def.opzioni !== undefined;

  switch (tipo) {
    case 'testo': {
      if (typeof rawValue !== 'string') {
        return {
          valid: false,
          empty: false,
          warning: 'Atteso testo (stringa)',
          formatted: stringifyRawValueForDisplay(rawValue),
        };
      }
      if (rawValue.length > MAX_PROPERTY_VALUE_LENGTH) {
        return {
          valid: false,
          empty: false,
          warning: `Supera il limite di ${MAX_PROPERTY_VALUE_LENGTH} caratteri`,
          formatted: rawValue,
        };
      }
      return { valid: true, empty: false, formatted: rawValue };
    }

    case 'numero': {
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
        return {
          valid: false,
          empty: false,
          warning: 'Valore non numerico',
          formatted: stringifyRawValueForDisplay(rawValue),
        };
      }
      return {
        valid: true,
        empty: false,
        formatted: formatNumberValue(rawValue, def.decimali),
      };
    }

    case 'seleziona': {
      if (typeof rawValue !== 'string') {
        return {
          valid: false,
          empty: false,
          warning: 'Atteso un valore singolo di selezione',
          formatted: stringifyRawValueForDisplay(rawValue),
        };
      }
      if (rawValue.length > MAX_PROPERTY_VALUE_LENGTH) {
        return {
          valid: false,
          empty: false,
          warning: `Supera ${MAX_PROPERTY_VALUE_LENGTH} caratteri`,
          formatted: rawValue,
        };
      }
      if (strictOptions && def.opzioni) {
        const exists = def.opzioni.some((o) => o.valore === rawValue);
        if (!exists) {
          return {
            valid: false,
            empty: false,
            warning: `Valore "${rawValue}" non presente tra le opzioni`,
            formatted: rawValue,
          };
        }
      }
      return { valid: true, empty: false, formatted: rawValue };
    }

    case 'selezione-multipla': {
      if (!Array.isArray(rawValue)) {
        return {
          valid: false,
          empty: false,
          warning: 'Attesa una lista di valori',
          formatted: stringifyRawValueForDisplay(rawValue),
        };
      }
      const nonString = rawValue.some((item) => typeof item !== 'string');
      if (nonString) {
        return {
          valid: false,
          empty: false,
          warning: 'La lista contiene elementi non testuali',
          formatted: stringifyRawValueForDisplay(rawValue),
        };
      }
      const strItems = rawValue as string[];
      if (strItems.some((s) => s.length > MAX_PROPERTY_VALUE_LENGTH)) {
        return {
          valid: false,
          empty: false,
          warning: `Un valore supera ${MAX_PROPERTY_VALUE_LENGTH} caratteri`,
          formatted: strItems.join(', '),
        };
      }
      if (strictOptions && def.opzioni && def.opzioni.length > 0) {
        const allowed = new Set(def.opzioni.map((o) => o.valore));
        const unknown = strItems.filter((s) => !allowed.has(s));
        if (unknown.length > 0) {
          return {
            valid: false,
            empty: false,
            warning: `Fuori dalle opzioni: ${unknown.join(', ')}`,
            formatted: strItems.join(', '),
          };
        }
      }
      return { valid: true, empty: false, formatted: strItems.join(', ') };
    }

    case 'stato': {
      if (typeof rawValue !== 'string') {
        return {
          valid: false,
          empty: false,
          warning: 'Atteso un valore di stato',
          formatted: stringifyRawValueForDisplay(rawValue),
        };
      }
      const options = def.opzioni ?? defaultStatusOptions();
      const match = options.find((o) => o.valore === rawValue);
      if (!match) {
        return {
          valid: false,
          empty: false,
          warning: `Stato "${rawValue}" non previsto tra le opzioni`,
          formatted: rawValue,
        };
      }
      return { valid: true, empty: false, formatted: rawValue };
    }

    case 'data':
    case 'creato':
    case 'modificato': {
      if (typeof rawValue !== 'string') {
        return {
          valid: false,
          empty: false,
          warning: 'Formato data non valido (usa AAAA-MM-GG)',
          formatted: stringifyRawValueForDisplay(rawValue),
        };
      }
      const parsed = parseDateOrInterval(rawValue);
      if (!parsed) {
        return {
          valid: false,
          empty: false,
          warning: 'Data non valida (atteso AAAA-MM-GG, AAAA-MM-GGTHH:MM o intervallo AAAA-MM-GG/AAAA-MM-GG)',
          formatted: rawValue,
        };
      }
      return {
        valid: true,
        empty: false,
        formatted: formatItalianDate(rawValue),
      };
    }

    case 'casella': {
      if (typeof rawValue !== 'boolean') {
        return {
          valid: false,
          empty: false,
          warning: 'Atteso true o false',
          formatted: stringifyRawValueForDisplay(rawValue),
        };
      }
      return {
        valid: true,
        empty: false,
        formatted: rawValue ? 'Sì' : 'No',
      };
    }

    case 'url': {
      if (
        typeof rawValue !== 'string' ||
        rawValue.length > MAX_PROPERTY_VALUE_LENGTH ||
        !isValidUrlValue(rawValue)
      ) {
        return {
          valid: false,
          empty: false,
          warning: 'URL non valido (deve iniziare con http:// o https://)',
          formatted: stringifyRawValueForDisplay(rawValue),
        };
      }
      return { valid: true, empty: false, formatted: rawValue };
    }

    case 'email': {
      if (
        typeof rawValue !== 'string' ||
        rawValue.length > MAX_PROPERTY_VALUE_LENGTH ||
        !isValidEmailValue(rawValue)
      ) {
        return {
          valid: false,
          empty: false,
          warning: 'Indirizzo email non valido',
          formatted: stringifyRawValueForDisplay(rawValue),
        };
      }
      return { valid: true, empty: false, formatted: rawValue };
    }

    case 'telefono': {
      if (
        typeof rawValue !== 'string' ||
        rawValue.length > MAX_PROPERTY_VALUE_LENGTH ||
        !isValidPhoneValue(rawValue)
      ) {
        return {
          valid: false,
          empty: false,
          warning: 'Numero di telefono non valido',
          formatted: stringifyRawValueForDisplay(rawValue),
        };
      }
      return { valid: true, empty: false, formatted: rawValue };
    }
  }
}

// ---------------------------------------------------------------------------
// Operazioni pure sullo schema (senza toccare le righe salvo migrazione opzioni)
// ---------------------------------------------------------------------------

export function addPropertyToSchema(
  schema: readonly PropertyDefinition[],
  input: {
    nome: string;
    tipo: PropertyType;
    opzioni?: PropertyOption[];
    predefinito?: unknown;
    decimali?: number;
  },
): { schema: PropertyDefinition[]; created: PropertyDefinition } {
  if (schema.length >= MAX_PROPERTIES_PER_TABLE) {
    throw badRequest(
      `Limite raggiunto: una tabella può avere al massimo ${MAX_PROPERTIES_PER_TABLE} proprietà.`,
    );
  }
  const cleanName = validatePropertyName(input.nome);
  const tipo = normalizePropertyType(input.tipo);
  if (!tipo || tipo === 'creato' || tipo === 'modificato') {
    throw badRequest(`Tipo proprietà "${String(input.tipo)}" non creabile manualmente.`);
  }
  const chiave = generateUniquePropertyKey(
    cleanName,
    tipo,
    schema.map((p) => p.chiave),
  );
  const opzioni =
    tipo === 'stato' && (!input.opzioni || input.opzioni.length === 0)
      ? defaultStatusOptions()
      : validateOptionsList(input.opzioni, tipo);

  const created: PropertyDefinition = {
    chiave,
    nome: cleanName,
    tipo,
    ...(opzioni !== undefined ? { opzioni } : {}),
    ...(input.predefinito !== undefined ? { predefinito: input.predefinito } : {}),
    ...(tipo === 'numero' && typeof input.decimali === 'number'
      ? { decimali: input.decimali }
      : {}),
  };

  return {
    schema: [...schema, created],
    created,
  };
}

/** Rinomina una proprietà cambiando SOLO l'etichetta `nome` (`chiave` immutabile). */
export function renamePropertyInSchema(
  schema: readonly PropertyDefinition[],
  chiave: string,
  nuovoNome: string,
): PropertyDefinition[] {
  const cleanName = validatePropertyName(nuovoNome);
  const idx = schema.findIndex((p) => p.chiave === chiave);
  if (idx === -1) {
    throw badRequest(`Proprietà "${chiave}" non trovata nello schema.`);
  }
  return schema.map((p, i) => (i === idx ? { ...p, nome: cleanName } : p));
}

/** Cambia SOLO il tipo nella definizione (i valori nei file non vengono riscritti). */
export function changePropertyTypeInSchema(
  schema: readonly PropertyDefinition[],
  chiave: string,
  nuovoTipo: PropertyType,
): PropertyDefinition[] {
  const tipo = normalizePropertyType(nuovoTipo);
  if (!tipo || tipo === 'creato' || tipo === 'modificato') {
    throw badRequest(`Tipo proprietà "${String(nuovoTipo)}" non valido.`);
  }
  validatePropertyKeyAndType(chiave, tipo);
  const idx = schema.findIndex((p) => p.chiave === chiave);
  if (idx === -1) {
    throw badRequest(`Proprietà "${chiave}" non trovata nello schema.`);
  }
  return schema.map((p, i) => {
    if (i !== idx) return p;
    const next: PropertyDefinition = {
      chiave: p.chiave,
      nome: p.nome,
      tipo,
    };
    if (tipo === 'seleziona' || tipo === 'selezione-multipla' || tipo === 'stato') {
      next.opzioni =
        p.opzioni && p.opzioni.length > 0
          ? validateOptionsList(p.opzioni, tipo)
          : tipo === 'stato'
            ? defaultStatusOptions()
            : [];
    }
    if (tipo === 'numero' && typeof p.decimali === 'number') {
      next.decimali = p.decimali;
    }
    return next;
  });
}

/**
 * Azione esplicita "Crea opzioni dai valori esistenti" (testo -> seleziona / selezione-multipla / stato).
 * Estrae i valori distinti presenti nelle righe e genera le opzioni colorate.
 */
export function buildOptionsFromExistingValues(
  rowValues: readonly unknown[],
  targetTipo: 'seleziona' | 'selezione-multipla' | 'stato',
  existingOptions: readonly PropertyOption[] = [],
): PropertyOption[] {
  const byValue = new Map<string, PropertyOption>();
  for (const opt of existingOptions) {
    byValue.set(opt.valore, { ...opt });
  }

  const addCandidate = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const val = raw.trim();
    if (!val || val.length > MAX_PROPERTY_VALUE_LENGTH) return;
    if (byValue.has(val) || byValue.size >= MAX_OPTIONS_PER_PROPERTY) return;
    const color = PROPERTY_COLORS[byValue.size % PROPERTY_COLORS.length]!;
    if (targetTipo === 'stato') {
      byValue.set(val, { valore: val, colore: color, gruppo: 'da-fare' });
    } else {
      byValue.set(val, { valore: val, colore: color });
    }
  };

  for (const rv of rowValues) {
    if (Array.isArray(rv)) {
      for (const item of rv) addCandidate(item);
    } else {
      addCandidate(rv);
    }
  }

  return [...byValue.values()];
}

export function updatePropertyOptionsInSchema(
  schema: readonly PropertyDefinition[],
  chiave: string,
  opzioni: readonly PropertyOption[],
): PropertyDefinition[] {
  const idx = schema.findIndex((p) => p.chiave === chiave);
  if (idx === -1) {
    throw badRequest(`Proprietà "${chiave}" non trovata nello schema.`);
  }
  const prop = schema[idx]!;
  if (
    prop.tipo !== 'seleziona' &&
    prop.tipo !== 'selezione-multipla' &&
    prop.tipo !== 'stato'
  ) {
    throw badRequest(`La proprietà "${chiave}" (${prop.tipo}) non supporta opzioni.`);
  }
  const validated = validateOptionsList(opzioni, prop.tipo) ?? [];
  return schema.map((p, i) => (i === idx ? { ...p, opzioni: validated } : p));
}

export function setPropertyDefaultInSchema(
  schema: readonly PropertyDefinition[],
  chiave: string,
  predefinito: unknown,
): PropertyDefinition[] {
  const idx = schema.findIndex((p) => p.chiave === chiave);
  if (idx === -1) {
    throw badRequest(`Proprietà "${chiave}" non trovata nello schema.`);
  }
  return schema.map((p, i) => {
    if (i !== idx) return p;
    const next = { ...p };
    if (predefinito === undefined || predefinito === null || predefinito === '') {
      delete next.predefinito;
    } else {
      next.predefinito = predefinito;
    }
    return next;
  });
}

export function setPropertyDecimalsInSchema(
  schema: readonly PropertyDefinition[],
  chiave: string,
  decimali: number | undefined,
): PropertyDefinition[] {
  const idx = schema.findIndex((p) => p.chiave === chiave);
  if (idx === -1) {
    throw badRequest(`Proprietà "${chiave}" non trovata nello schema.`);
  }
  return schema.map((p, i) => {
    if (i !== idx) return p;
    const next = { ...p };
    if (decimali === undefined || decimali === null) {
      delete next.decimali;
    } else {
      if (!Number.isInteger(decimali) || decimali < 0 || decimali > 10) {
        throw badRequest('Il numero di decimali deve essere compreso tra 0 e 10.');
      }
      next.decimali = decimali;
    }
    return next;
  });
}

export function reorderPropertiesInSchema(
  schema: readonly PropertyDefinition[],
  orderedKeys: readonly string[],
): PropertyDefinition[] {
  const byKey = new Map(schema.map((p) => [p.chiave, p]));
  const out: PropertyDefinition[] = [];
  const seen = new Set<string>();
  for (const k of orderedKeys) {
    const found = byKey.get(k);
    if (found && !seen.has(k)) {
      out.push(found);
      seen.add(k);
    }
  }
  for (const p of schema) {
    if (!seen.has(p.chiave)) {
      out.push(p);
      seen.add(p.chiave);
    }
  }
  return out;
}

/**
 * Elimina la proprietà dallo schema (senza toccare le righe, dove i valori restano
 * come "campi non definiti").
 */
export function deletePropertyFromSchema(
  schema: readonly PropertyDefinition[],
  chiave: string,
): PropertyDefinition[] {
  if (!schema.some((p) => p.chiave === chiave)) {
    throw badRequest(`Proprietà "${chiave}" non trovata nello schema.`);
  }
  return schema.filter((p) => p.chiave !== chiave);
}

/**
 * Ripristina la definizione di un "campo non definito" mantenendo la stessa `chiave`
 * e scegliendo il tipo desiderato.
 */
export function restoreUndefinedPropertyToSchema(
  schema: readonly PropertyDefinition[],
  input: {
    chiave: string;
    nome?: string;
    tipo: PropertyType;
    opzioni?: PropertyOption[];
  },
): PropertyDefinition[] {
  if (schema.length >= MAX_PROPERTIES_PER_TABLE) {
    throw badRequest(`Limite massimo di ${MAX_PROPERTIES_PER_TABLE} proprietà raggiunto.`);
  }
  const cleanKey = input.chiave.trim();
  const tipo = normalizePropertyType(input.tipo) ?? 'testo';
  validatePropertyKeyAndType(cleanKey, tipo);
  if (schema.some((p) => p.chiave.toLowerCase() === cleanKey.toLowerCase())) {
    throw badRequest(`La proprietà "${cleanKey}" è già definita nello schema.`);
  }
  const nome = validatePropertyName(input.nome?.trim() || cleanKey);
  const opzioni =
    tipo === 'stato' && (!input.opzioni || input.opzioni.length === 0)
      ? defaultStatusOptions()
      : validateOptionsList(input.opzioni, tipo);

  return [
    ...schema,
    {
      chiave: cleanKey,
      nome,
      tipo,
      ...(opzioni !== undefined ? { opzioni } : {}),
    },
  ];
}

/**
 * Pianifica la rinomina esplicita del valore di un'opzione sia nello schema
 * sia nelle pagine interessate (usato per l'anteprima "verranno modificate N pagine" e per la patch).
 */
export function planOptionRenameMigration(
  schema: readonly PropertyDefinition[],
  rows: ReadonlyArray<{ path: string; content: string; values: Record<string, unknown> }>,
  chiave: string,
  vecchioValore: string,
  nuovoValore: string,
): {
  updatedSchema: PropertyDefinition[];
  affectedRows: Array<{ path: string; nextValue: unknown; patchedContent: string }>;
} {
  const cleanOld = vecchioValore.trim();
  const cleanNew = nuovoValore.trim();
  if (!cleanOld || !cleanNew) {
    throw badRequest('Il valore dell\'opzione non può essere vuoto.');
  }
  if (cleanNew.length > MAX_PROPERTY_VALUE_LENGTH) {
    throw badRequest(
      `Il valore dell'opzione non può superare ${MAX_PROPERTY_VALUE_LENGTH} caratteri.`,
    );
  }

  const prop = schema.find((p) => p.chiave === chiave);
  if (!prop || !prop.opzioni) {
    throw badRequest(`Proprietà con opzioni "${chiave}" non trovata.`);
  }

  const nextOptions: PropertyOption[] = [];
  const seen = new Set<string>();
  for (const o of prop.opzioni) {
    const val = o.valore === cleanOld ? cleanNew : o.valore;
    if (!seen.has(val)) {
      seen.add(val);
      nextOptions.push({ ...o, valore: val });
    }
  }
  const updatedSchema = updatePropertyOptionsInSchema(schema, chiave, nextOptions);

  const affectedRows: Array<{ path: string; nextValue: unknown; patchedContent: string }> = [];
  for (const row of rows) {
    const curVal = row.values[chiave];
    if (prop.tipo === 'selezione-multipla' && Array.isArray(curVal)) {
      if (curVal.includes(cleanOld)) {
        const nextArr = Array.from(
          new Set(curVal.map((v) => (v === cleanOld ? cleanNew : v))),
        );
        const patchedContent = patchFrontmatterField(row.content, chiave, nextArr);
        affectedRows.push({ path: row.path, nextValue: nextArr, patchedContent });
      }
    } else if (curVal === cleanOld) {
      const patchedContent = patchFrontmatterField(row.content, chiave, cleanNew);
      affectedRows.push({ path: row.path, nextValue: cleanNew, patchedContent });
    }
  }

  return { updatedSchema, affectedRows };
}

/**
 * Individua tutti i "campi non definiti" presenti nei frontmatter delle righe
 * (per esempio dopo l'eliminazione di una proprietà dallo schema), così l'utente
 * può vederli e ripristinarne la definizione mantenendo la stessa chiave.
 */
export function detectUndefinedFields(
  rows: ReadonlyArray<{ values: Record<string, unknown> }>,
  schema: readonly PropertyDefinition[],
): UndefinedFieldInfo[] {
  const definedLower = new Set(schema.map((p) => p.chiave.toLowerCase()));
  const map = new Map<string, { chiave: string; count: number; sampleValues: unknown[] }>();

  for (const row of rows) {
    for (const [k, v] of Object.entries(row.values)) {
      const lower = k.toLowerCase();
      if (RESERVED_PROPERTY_KEYS.has(lower) || definedLower.has(lower)) continue;
      if (v === undefined || v === null || v === '') continue;
      const existing = map.get(lower);
      if (existing) {
        existing.count++;
        if (existing.sampleValues.length < 5) existing.sampleValues.push(v);
      } else {
        map.set(lower, { chiave: k, count: 1, sampleValues: [v] });
      }
    }
  }

  return [...map.values()]
    .map((item) => ({
      chiave: item.chiave,
      count: item.count,
      sampleValues: item.sampleValues,
      inferredType: inferPropertyTypeFromValue(item.chiave, item.sampleValues[0]),
    }))
    .sort((a, b) => a.chiave.localeCompare(b.chiave, 'it'));
}
