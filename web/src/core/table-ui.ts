import type {
  FilterOperator,
  PropertyColor,
  PropertyOption,
  PropertyType,
  StatusGroup,
} from '@brain/shared';
import { defaultStatusOptions, formatNumberValue } from '../../../packages/kb-core/src/schema.js';
import type { VistaParseOutcome } from '../../../packages/kb-core/src/vista-block.js';

export {
  addPropertyToSchema,
  buildOptionsFromExistingValues,
  changePropertyTypeInSchema,
  createDefaultDatabaseSchema,
  defaultStatusOptions,
  deletePropertyFromSchema,
  detectUndefinedFields,
  formatItalianDate,
  formatNumberValue,
  generateUniquePropertyKey,
  inferPropertyTypeFromValue,
  MAX_OPTIONS_PER_PROPERTY,
  MAX_PROPERTIES_PER_TABLE,
  MAX_PROPERTY_NAME_LENGTH,
  MAX_PROPERTY_VALUE_LENGTH,
  parseDateOrInterval,
  parsePropertyDefinitions,
  planOptionRenameMigration,
  PROPERTY_COLORS,
  PROPERTY_TYPES,
  renamePropertyInSchema,
  reorderPropertiesInSchema,
  RESERVED_PROPERTY_KEYS,
  restoreUndefinedPropertyToSchema,
  serializePropertyDefinitions,
  setPropertyDecimalsInSchema,
  setPropertyDefaultInSchema,
  slugifyBaseKey,
  STATUS_GROUPS,
  updatePropertyOptionsInSchema,
  validatePropertyValue,
} from '../../../packages/kb-core/src/schema.js';

export {
  extractVistaBlocks,
  parseVistaBlockYaml,
  parseVistaSource,
  replaceVistaBlockInMarkdown,
  serializeVistaBlock,
  type ExtractedVistaBlock,
  type VistaParseOutcome,
} from '../../../packages/kb-core/src/vista-block.js';

export type ParseVistaResult = VistaParseOutcome;

export {
  attachValidationWarningsToRows,
  filterTableRows,
  getRowCellValue,
  isRowValueEmpty,
  resolveEffectiveColumns,
  sortTableRows,
} from '../../../packages/kb-core/src/table-engine.js';

export function formatNumberWithDecimals(val: number, decimali?: number): string {
  return formatNumberValue(val, decimali);
}

export function createDefaultOptionsForType(tipo: PropertyType): PropertyOption[] {
  if (tipo === 'stato') {
    return defaultStatusOptions();
  }
  if (tipo === 'seleziona' || tipo === 'selezione-multipla') {
    return [
      { valore: 'Opzione 1', colore: 'blu' },
      { valore: 'Opzione 2', colore: 'verde' },
    ];
  }
  return [];
}

export interface PropertyTypeMeta {
  type: PropertyType;
  label: string;
  description: string;
  readOnly?: boolean;
  hasOptions?: boolean;
}

export const PRIMARY_COLUMN_TYPES = [
  'testo',
  'numero',
  'data',
  'selezione-multipla',
] as const;

export type PrimaryColumnType = (typeof PRIMARY_COLUMN_TYPES)[number];

export const PRIMARY_PROPERTY_TYPE_META: readonly PropertyTypeMeta[] = [
  { type: 'testo', label: 'Testo', description: 'Stringa di testo o note' },
  { type: 'numero', label: 'Numero', description: 'Valore numerico (allineato a destra, decimali opzionali)' },
  { type: 'data', label: 'Data', description: 'Data singola, con ora o intervallo (formato italiano)' },
  {
    type: 'selezione-multipla',
    label: 'Selezione multipla',
    description: 'Etichette e pillole colorate (es. persone, tag, categorie)',
    hasOptions: true,
  },
] as const;

export const PROPERTY_TYPE_META: readonly PropertyTypeMeta[] = [
  { type: 'testo', label: 'Testo', description: 'Stringa di testo breve' },
  { type: 'numero', label: 'Numero', description: 'Valore numerico con decimali configurabili' },
  {
    type: 'seleziona',
    label: 'Seleziona',
    description: 'Singolo valore scelto tra opzioni colorate',
    hasOptions: true,
  },
  {
    type: 'selezione-multipla',
    label: 'Selezione multipla',
    description: 'Lista di valori (es. Persone, partecipanti, tag)',
    hasOptions: true,
  },
  {
    type: 'stato',
    label: 'Stato',
    description: 'Avanzamento raggruppato in Da fare, In corso, Completato',
    hasOptions: true,
  },
  {
    type: 'data',
    label: 'Data',
    description: 'Data singola, con ora opzionale o intervallo',
  },
  { type: 'casella', label: 'Casella', description: 'Vero / falso cliccabile' },
  { type: 'url', label: 'URL', description: 'Link web cliccabile' },
  { type: 'email', label: 'Email', description: 'Indirizzo email cliccabile (mailto:)' },
  { type: 'telefono', label: 'Telefono', description: 'Numero di telefono cliccabile (tel:)' },
  {
    type: 'creato',
    label: 'Creato il',
    description: 'Data di creazione della pagina (sola lettura)',
    readOnly: true,
  },
  {
    type: 'modificato',
    label: 'Modificato il',
    description: 'Data di ultima modifica del file (sola lettura)',
    readOnly: true,
  },
] as const;

export const COLOR_PALETTE_META: Record<
  PropertyColor,
  { label: string; bg: string; text: string; dot: string; border: string }
> = {
  grigio: {
    label: 'Grigio',
    bg: 'rgba(120, 119, 116, 0.16)',
    text: '#5a5955',
    dot: '#787774',
    border: 'rgba(120, 119, 116, 0.3)',
  },
  marrone: {
    label: 'Marrone',
    bg: 'rgba(159, 107, 83, 0.18)',
    text: '#69402c',
    dot: '#9f6b53',
    border: 'rgba(159, 107, 83, 0.35)',
  },
  arancione: {
    label: 'Arancione',
    bg: 'rgba(217, 115, 13, 0.16)',
    text: '#854c1d',
    dot: '#d9730d',
    border: 'rgba(217, 115, 13, 0.35)',
  },
  giallo: {
    label: 'Giallo',
    bg: 'rgba(203, 145, 47, 0.18)',
    text: '#73521b',
    dot: '#cb912f',
    border: 'rgba(203, 145, 47, 0.38)',
  },
  verde: {
    label: 'Verde',
    bg: 'rgba(68, 131, 97, 0.16)',
    text: '#2b593f',
    dot: '#448361',
    border: 'rgba(68, 131, 97, 0.35)',
  },
  blu: {
    label: 'Blu',
    bg: 'rgba(51, 126, 169, 0.16)',
    text: '#28456c',
    dot: '#337ea9',
    border: 'rgba(51, 126, 169, 0.35)',
  },
  viola: {
    label: 'Viola',
    bg: 'rgba(144, 101, 176, 0.16)',
    text: '#492f64',
    dot: '#9065b0',
    border: 'rgba(144, 101, 176, 0.35)',
  },
  rosa: {
    label: 'Rosa',
    bg: 'rgba(193, 76, 138, 0.16)',
    text: '#69314c',
    dot: '#c14c8a',
    border: 'rgba(193, 76, 138, 0.35)',
  },
  rosso: {
    label: 'Rosso',
    bg: 'rgba(212, 76, 71, 0.16)',
    text: '#6e3630',
    dot: '#d44c47',
    border: 'rgba(212, 76, 71, 0.35)',
  },
};

export const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
  'da-fare': 'Da fare',
  'in-corso': 'In corso',
  completato: 'Completato',
};

export const FILTER_OPERATOR_META: readonly {
  op: FilterOperator;
  label: string;
  needsValue: boolean;
}[] = [
  { op: 'uguale', label: 'è uguale a', needsValue: true },
  { op: 'diverso', label: 'è diverso da', needsValue: true },
  { op: 'contiene', label: 'contiene', needsValue: true },
  { op: 'include', label: 'include', needsValue: true },
  { op: 'vuoto', label: 'è vuoto', needsValue: false },
  { op: 'non-vuoto', label: 'non è vuoto', needsValue: false },
  { op: 'prima-di', label: 'è prima di', needsValue: true },
  { op: 'dopo-di', label: 'è dopo di', needsValue: true },
  { op: 'maggiore', label: 'è maggiore di (>)', needsValue: true },
  { op: 'minore', label: 'è minore di (<)', needsValue: true },
] as const;

export function getPropertyTypeLabel(tipo: PropertyType): string {
  return PROPERTY_TYPE_META.find((m) => m.type === tipo)?.label ?? tipo;
}
