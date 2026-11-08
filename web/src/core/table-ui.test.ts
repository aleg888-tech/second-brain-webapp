import { describe, expect, it } from 'vitest';
import {
  COLOR_PALETTE_META,
  extractVistaBlocks,
  FILTER_OPERATOR_META,
  formatItalianDate,
  getPropertyTypeLabel,
  PRIMARY_COLUMN_TYPES,
  PRIMARY_PROPERTY_TYPE_META,
  PROPERTY_COLORS,
  PROPERTY_TYPE_META,
  replaceVistaBlockInMarkdown,
  serializeVistaBlock,
  validatePropertyValue,
} from './table-ui';

describe('web/core/table-ui — metadati UI, blocchi vista e validazione tollerante', () => {
  it('espone i 4 formati primari di colonna (testo, numero, data, selezione multipla) e tutti i metadati UI', () => {
    expect(PRIMARY_COLUMN_TYPES).toEqual(['testo', 'numero', 'data', 'selezione-multipla']);
    expect(PRIMARY_PROPERTY_TYPE_META.map((m) => m.type)).toEqual([
      'testo',
      'numero',
      'data',
      'selezione-multipla',
    ]);
    expect(PROPERTY_TYPE_META).toHaveLength(12);
    expect(PROPERTY_COLORS).toHaveLength(9);
    for (const c of PROPERTY_COLORS) {
      expect(COLOR_PALETTE_META[c]).toBeDefined();
    }
    expect(FILTER_OPERATOR_META).toHaveLength(10);
    expect(getPropertyTypeLabel('selezione-multipla')).toBe('Selezione multipla');
  });

  it('estrae e aggiorna più blocchi vista e legacy ![[page:...]] nello stesso documento Markdown', () => {
    const doc = [
      '# Pagina ospite',
      '',
      '```vista',
      'fonte: database p_a1b2c3',
      'colonne: [stato, data]',
      '```',
      '',
      'Testo intermedio',
      '',
      '![[page:p_998877]]',
      '',
    ].join('\n');

    const extracted = extractVistaBlocks(doc);
    expect(extracted).toHaveLength(2);
    expect(extracted[0]?.kind).toBe('vista');
    expect(extracted[0]?.parsed.ok).toBe(true);
    if (extracted[0]?.parsed.ok) {
      expect(extracted[0].parsed.config.fonte).toBe('database p_a1b2c3');
    }
    expect(extracted[1]?.kind).toBe('legacy-embed');
    expect(extracted[1]?.parsed.ok).toBe(true);
    if (extracted[1]?.parsed.ok) {
      expect(extracted[1].parsed.config.fonte).toBe('database p_998877');
    }

    // Conversione esplicita del secondo blocco (legacy) in blocco ```vista al salvataggio della vista
    const updatedDoc = replaceVistaBlockInMarkdown(doc, 1, {
      fonte: 'database p_998877',
      colonne: ['titolo', 'stato'],
      ordina: [{ proprieta: 'stato', direzione: 'asc' }],
    });
    expect(updatedDoc).toContain('fonte: database p_a1b2c3');
    expect(updatedDoc).toContain('fonte: database p_998877');
    expect(updatedDoc).not.toContain('![[page:p_998877]]');
    expect(serializeVistaBlock({ fonte: 'tutte' })).toContain('fonte: tutte');
  });

  it('formatta date italiane e valida valori in modo tollerante senza alterarli', () => {
    expect(formatItalianDate('2026-09-01/2026-11-30')).toBe(
      '1 settembre 2026 → 30 novembre 2026',
    );
    const invalidRes = validatePropertyValue(
      {
        tipo: 'selezione-multipla',
        opzioni: [{ valore: 'Anna', colore: 'rosa' }],
      },
      'non-una-lista',
    );
    expect(invalidRes.valid).toBe(false);
    expect(invalidRes.warning).toBeTruthy();
  });
});
