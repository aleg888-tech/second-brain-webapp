import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Mail,
  Phone,
  Plus,
  Trash2,
} from 'lucide-react';
import type { PropertyDefinition, PropertyType } from '@brain/shared';
import {
  formatItalianDate,
  formatNumberWithDecimals,
  generateUniquePropertyKey,
  getPropertyTypeLabel,
  inferPropertyTypeFromValue,
  validatePropertyValue,
} from '../core/table-ui';
import { renderOptionPill, renderPropertyTypeIcon } from './TableViewWidget';

const HIDDEN_STRUCTURAL_KEYS = new Set([
  'id',
  'icona',
  'copertina',
  'tipo',
  'proprieta',
  'versione-schema',
  'titolo',
]);

export interface PropertiesPanelProps {
  frontmatter: Record<string, unknown> | null;
  keyOrder: string[];
  /** Schema ereditato se la pagina è una riga dentro una cartella-database. */
  databaseSchema?: PropertyDefinition[] | null;
  onPatchProperty: (key: string, value: unknown, unset?: boolean) => Promise<void>;
}

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
  frontmatter,
  keyOrder,
  databaseSchema,
  onPatchProperty,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [addingProp, setAddingProp] = useState(false);
  const [newPropName, setNewPropName] = useState('');
  const [newPropType, setNewPropType] = useState<PropertyType>('testo');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const effectiveProps = useMemo<
    Array<{
      def: PropertyDefinition;
      value: unknown;
      fromSchema: boolean;
    }>
  >(() => {
    const fm = frontmatter ?? {};
    const schemaByKey = new Map<string, PropertyDefinition>();
    if (databaseSchema) {
      for (const s of databaseSchema) {
        schemaByKey.set(s.chiave, s);
      }
    }

    const result: Array<{
      def: PropertyDefinition;
      value: unknown;
      fromSchema: boolean;
    }> = [];
    const visited = new Set<string>();

    // Prima le proprietà definite nello schema del database (se la pagina appartiene a un database)
    if (databaseSchema) {
      for (const s of databaseSchema) {
        visited.add(s.chiave);
        result.push({
          def: s,
          value: fm[s.chiave],
          fromSchema: true,
        });
      }
    }

    // Poi tutte le altre chiavi presenti nel frontmatter nell'ordine in cui compaiono nel file
    const allKeys = [
      ...keyOrder,
      ...Object.keys(fm).filter((k) => !keyOrder.includes(k)),
    ];
    for (const key of allKeys) {
      if (visited.has(key) || HIDDEN_STRUCTURAL_KEYS.has(key.toLowerCase())) {
        continue;
      }
      visited.add(key);
      const val = fm[key];
      const inferred: PropertyType = inferPropertyTypeFromValue(key, val);
      result.push({
        def: {
          chiave: key,
          nome: key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, ' '),
          tipo: inferred,
        },
        value: val,
        fromSchema: false,
      });
    }

    return result;
  }, [frontmatter, keyOrder, databaseSchema]);

  const handleAddStandaloneProperty = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newPropName.trim();
    if (!trimmed) return;
    try {
      setErrorMsg(null);
      const existingKeys = effectiveProps.map((p) => p.def.chiave);
      const chiave =
        trimmed.toLowerCase() === 'tag'
          ? 'tag'
          : generateUniquePropertyKey(
              trimmed,
              trimmed.toLowerCase() === 'tag' ? 'selezione-multipla' : newPropType,
              existingKeys,
            );

      let initialVal: unknown = '';
      if (newPropType === 'numero') initialVal = 0;
      else if (newPropType === 'casella') initialVal = false;
      else if (newPropType === 'data') initialVal = new Date().toISOString().slice(0, 10);
      else if (newPropType === 'selezione-multipla' || chiave === 'tag') initialVal = [];

      await onPatchProperty(chiave, initialVal, false);
      setNewPropName('');
      setAddingProp(false);
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  if (effectiveProps.length === 0 && !addingProp) {
    return (
      <div className="notion-props-panel is-empty">
        <button
          type="button"
          className="notion-props-add-trigger"
          onClick={() => setAddingProp(true)}
        >
          <Plus size={13} /> Aggiungi proprietà
        </button>
      </div>
    );
  }

  return (
    <div className="notion-props-panel">
      <div className="notion-props-header">
        <button
          type="button"
          className="notion-props-toggle-btn"
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <span>Proprietà ({effectiveProps.length})</span>
        </button>
        {!collapsed && (
          <button
            type="button"
            className="notion-props-add-trigger"
            onClick={() => setAddingProp((v) => !v)}
          >
            <Plus size={13} /> Aggiungi proprietà
          </button>
        )}
      </div>

      {errorMsg && (
        <div className="notion-table-error-banner" style={{ marginBottom: 6 }}>
          <AlertTriangle size={13} />
          <span>{errorMsg}</span>
        </div>
      )}

      {!collapsed && (
        <div className="notion-props-list">
          {effectiveProps.map(({ def, value, fromSchema }) => {
            const validation = validatePropertyValue(def, value);
            const isReadOnly = def.tipo === 'creato' || def.tipo === 'modificato';

            return (
              <div key={def.chiave} className="notion-prop-row">
                <div className="notion-prop-label" title={`Chiave YAML: ${def.chiave} (${getPropertyTypeLabel(def.tipo)})`}>
                  {renderPropertyTypeIcon(def.tipo, 13)}
                  <span>{def.nome}</span>
                </div>

                <div className="notion-prop-value">
                  {!validation.valid && validation.warning && (
                    <span
                      className="notion-cell-warning-badge"
                      title={validation.warning}
                      style={{ marginRight: 6 }}
                    >
                      <AlertTriangle size={12} /> {validation.warning}
                    </span>
                  )}

                  {isReadOnly ? (
                    <span className="notion-prop-readonly">
                      {typeof value === 'string'
                        ? formatItalianDate(value) ?? value
                        : String(value ?? '')}
                    </span>
                  ) : def.tipo === 'casella' && typeof value === 'boolean' ? (
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(e) =>
                        void onPatchProperty(def.chiave, e.target.checked, false)
                      }
                    />
                  ) : (def.tipo === 'seleziona' || def.tipo === 'stato') &&
                    def.opzioni &&
                    def.opzioni.length > 0 ? (
                    <select
                      className="notion-prop-select"
                      value={typeof value === 'string' ? value : ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        void onPatchProperty(
                          def.chiave,
                          v === '' ? undefined : v,
                          v === '',
                        );
                      }}
                    >
                      <option value="">— Vuoto —</option>
                      {def.opzioni.map((o) => (
                        <option key={o.valore} value={o.valore}>
                          {o.valore}
                        </option>
                      ))}
                    </select>
                  ) : def.tipo === 'selezione-multipla' ? (
                    <div className="notion-prop-multi-wrap">
                      {Array.isArray(value) &&
                        value.map((item, idx) => {
                          const s = String(item);
                          const opt = def.opzioni?.find((o) => o.valore === s);
                          return (
                            <span
                              key={`${s}-${idx}`}
                              onClick={() => {
                                const next = (value as unknown[])
                                  .map(String)
                                  .filter((_, i) => i !== idx);
                                void onPatchProperty(def.chiave, next, false);
                              }}
                              title="Clicca per rimuovere"
                              style={{ cursor: 'pointer' }}
                            >
                              {renderOptionPill(s, opt, false)}
                            </span>
                          );
                        })}
                      <input
                        type="text"
                        className="notion-prop-inline-input"
                        placeholder="+ Aggiungi valore (Invio)..."
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const v = (e.target as HTMLInputElement).value.trim();
                            if (!v) return;
                            const cur = Array.isArray(value) ? value.map(String) : [];
                            if (!cur.includes(v)) {
                              void onPatchProperty(def.chiave, [...cur, v], false);
                            }
                            (e.target as HTMLInputElement).value = '';
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                      <input
                        type={def.tipo === 'numero' ? 'number' : 'text'}
                        step="any"
                        className="notion-prop-inline-input"
                        defaultValue={
                          value === null || value === undefined
                            ? ''
                            : typeof value === 'object'
                              ? JSON.stringify(value)
                              : String(value)
                        }
                        placeholder={
                          def.tipo === 'data'
                            ? 'AAAA-MM-GG o AAAA-MM-GG/AAAA-MM-GG'
                            : 'Vuoto'
                        }
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          const prevStr =
                            value === null || value === undefined ? '' : String(value);
                          if (raw === prevStr) return;
                          if (raw === '') {
                            void onPatchProperty(def.chiave, undefined, true);
                          } else if (def.tipo === 'numero') {
                            const n = Number(raw);
                            void onPatchProperty(
                              def.chiave,
                              Number.isFinite(n) ? n : raw,
                              false,
                            );
                          } else {
                            void onPatchProperty(def.chiave, raw, false);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                      />
                      {def.tipo === 'data' &&
                        typeof value === 'string' &&
                        formatItalianDate(value) && (
                          <span className="notion-muted" style={{ fontSize: 12 }}>
                            ({formatItalianDate(value)})
                          </span>
                        )}
                      {def.tipo === 'numero' &&
                        typeof value === 'number' &&
                        def.decimali !== undefined && (
                          <span className="notion-muted" style={{ fontSize: 12 }}>
                            ({formatNumberWithDecimals(value, def.decimali)})
                          </span>
                        )}
                      {def.tipo === 'url' && typeof value === 'string' && value && (
                        <a
                          href={value}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="notion-cell-link"
                        >
                          <ExternalLink size={12} />
                        </a>
                      )}
                      {def.tipo === 'email' && typeof value === 'string' && value && (
                        <a href={`mailto:${value}`} className="notion-cell-link">
                          <Mail size={12} />
                        </a>
                      )}
                      {def.tipo === 'telefono' && typeof value === 'string' && value && (
                        <a href={`tel:${value}`} className="notion-cell-link">
                          <Phone size={12} />
                        </a>
                      )}
                    </div>
                  )}

                  {!fromSchema && (
                    <button
                      type="button"
                      className="notion-icon-btn"
                      title="Rimuovi campo dal frontmatter di questa pagina"
                      onClick={() => void onPatchProperty(def.chiave, undefined, true)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {addingProp && (
        <form
          className="notion-props-add-form"
          onSubmit={(e) => void handleAddStandaloneProperty(e)}
        >
          <input
            type="text"
            className="notion-input"
            placeholder="Nome proprietà (es. Scadenza, Priorità, Tag)..."
            value={newPropName}
            onChange={(e) => setNewPropName(e.target.value)}
            autoFocus
          />
          <select
            className="notion-prop-select"
            value={newPropType}
            onChange={(e) => setNewPropType(e.target.value as PropertyType)}
          >
            <option value="testo">Testo</option>
            <option value="numero">Numero</option>
            <option value="data">Data</option>
            <option value="selezione-multipla">Selezione multipla (es. Tag)</option>
          </select>
          <button type="submit" className="notion-vista-btn is-primary">
            Aggiungi
          </button>
          <button
            type="button"
            className="notion-vista-btn"
            onClick={() => setAddingProp(false)}
          >
            Annulla
          </button>
        </form>
      )}
    </div>
  );
};
