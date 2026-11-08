import YAML from 'yaml';
import type {
  FilterOperator,
  VistaBlockConfig,
  VistaColumnSpec,
  VistaFilter,
  VistaSort,
} from '@brain/shared';
import { badRequest } from './errors.js';
import { parsePropertyDefinitions, serializePropertyDefinitions } from './schema.js';

export const FILTER_OPERATORS: readonly FilterOperator[] = [
  'uguale',
  'diverso',
  'contiene',
  'vuoto',
  'non-vuoto',
  'prima-di',
  'dopo-di',
  'maggiore',
  'minore',
  'include',
] as const;

export interface ParsedVistaSource {
  type: 'database' | 'sottopagine' | 'discendenti' | 'tutte';
  targetId?: string;
}

export function parseVistaSource(rawFonte: unknown): ParsedVistaSource | null {
  if (typeof rawFonte !== 'string') return null;
  const trimmed = rawFonte.trim();
  if (!trimmed) return null;

  if (trimmed === 'sottopagine') {
    return { type: 'sottopagine' };
  }
  if (trimmed === 'tutte') {
    return { type: 'tutte' };
  }
  if (trimmed === 'discendenti') {
    return { type: 'discendenti' };
  }
  const mDb = /^database\s+(p_[a-zA-Z0-9_-]+)$/i.exec(trimmed);
  if (mDb) {
    return { type: 'database', targetId: mDb[1]! };
  }
  const mDesc = /^discendenti\s+(p_[a-zA-Z0-9_-]+)$/i.exec(trimmed);
  if (mDesc) {
    return { type: 'discendenti', targetId: mDesc[1]! };
  }
  return null;
}

export type VistaParseOutcome =
  | { ok: true; config: VistaBlockConfig; source: ParsedVistaSource }
  | { ok: false; error: string };

/**
 * Analizza il contenuto YAML di un blocco ```vista ... ``` senza mai modificare il testo.
 * Se lo YAML non è valido o la fonte è mancante/errata, restituisce `{ ok: false, error }`.
 */
export function parseVistaBlockYaml(rawYaml: string): VistaParseOutcome {
  if (!rawYaml || rawYaml.trim() === '') {
    return { ok: false, error: 'Blocco vista vuoto: specifica almeno "fonte:".' };
  }

  const doc = YAML.parseDocument(rawYaml, { prettyErrors: false });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      error: `YAML non valido nel blocco vista: ${doc.errors[0]!.message}`,
    };
  }

  const js = doc.toJS({ maxAliasCount: 20 });
  if (!js || typeof js !== 'object' || Array.isArray(js)) {
    return {
      ok: false,
      error: 'Il blocco vista deve essere una mappa YAML chiave-valore.',
    };
  }

  const rec = js as Record<string, unknown>;
  const source = parseVistaSource(rec.fonte);
  if (!source) {
    return {
      ok: false,
      error:
        'Campo "fonte" mancante o non valido. Usa "database p_...", "sottopagine", "discendenti" o "tutte".',
    };
  }

  let colonne: VistaColumnSpec[] | undefined;
  if (Array.isArray(rec.colonne)) {
    colonne = [];
    for (const c of rec.colonne) {
      if (typeof c === 'string' && c.trim()) {
        colonne.push(c.trim());
      } else if (c && typeof c === 'object' && !Array.isArray(c)) {
        const cObj = c as Record<string, unknown>;
        const k = typeof cObj.chiave === 'string' ? cObj.chiave.trim() : '';
        if (!k) continue;
        const w =
          typeof cObj.larghezza === 'number' && Number.isFinite(cObj.larghezza) && cObj.larghezza > 30
            ? Math.round(cObj.larghezza)
            : undefined;
        colonne.push(w ? { chiave: k, larghezza: w } : k);
      }
    }
  }

  let larghezze: Record<string, number> | undefined;
  if (rec.larghezze && typeof rec.larghezze === 'object' && !Array.isArray(rec.larghezze)) {
    larghezze = {};
    for (const [k, v] of Object.entries(rec.larghezze as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 30) {
        larghezze[k] = Math.round(v);
      }
    }
  }

  let ordina: VistaSort[] | undefined;
  if (Array.isArray(rec.ordina)) {
    ordina = [];
    for (const s of rec.ordina) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
      const sObj = s as Record<string, unknown>;
      const prop = typeof sObj.proprieta === 'string' ? sObj.proprieta.trim() : '';
      if (!prop) continue;
      const dir =
        typeof sObj.direzione === 'string' && sObj.direzione.toLowerCase() === 'desc'
          ? 'desc'
          : 'asc';
      ordina.push({ proprieta: prop, direzione: dir });
    }
  }

  let filtri: VistaFilter[] | undefined;
  if (Array.isArray(rec.filtri)) {
    filtri = [];
    for (const f of rec.filtri) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
      const fObj = f as Record<string, unknown>;
      const prop = typeof fObj.proprieta === 'string' ? fObj.proprieta.trim() : '';
      const op =
        typeof fObj.operatore === 'string'
          ? (fObj.operatore.trim().toLowerCase() as FilterOperator)
          : null;
      if (!prop || !op || !(FILTER_OPERATORS as readonly string[]).includes(op)) continue;
      filtri.push({
        proprieta: prop,
        operatore: op,
        ...(fObj.valore !== undefined ? { valore: fObj.valore } : {}),
      });
    }
  }

  const proprieta = Array.isArray(rec.proprieta)
    ? parsePropertyDefinitions(rec.proprieta)
    : undefined;

  const schema =
    typeof rec.schema === 'string' && rec.schema.trim() ? rec.schema.trim() : undefined;

  const config: VistaBlockConfig = {
    fonte: String(rec.fonte).trim(),
    ...(colonne !== undefined ? { colonne } : {}),
    ...(larghezze && Object.keys(larghezze).length > 0 ? { larghezze } : {}),
    ...(ordina !== undefined ? { ordina } : {}),
    ...(filtri !== undefined ? { filtri } : {}),
    ...(proprieta !== undefined ? { proprieta } : {}),
    ...(schema !== undefined ? { schema } : {}),
  };

  return { ok: true, config, source };
}

/**
 * Serializza una `VistaBlockConfig` in un blocco fenced ```vista ... ``` pulito e leggibile.
 */
export function serializeVistaBlock(
  config: VistaBlockConfig,
  eol: '\r\n' | '\n' = '\n',
): string {
  const doc = new YAML.Document({});
  const root = doc.contents as YAML.YAMLMap;

  root.set('fonte', config.fonte);

  if (config.schema) {
    root.set('schema', config.schema);
  }

  if (config.colonne && config.colonne.length > 0) {
    const seq = doc.createNode(config.colonne) as YAML.YAMLSeq;
    seq.flow = config.colonne.every((c) => typeof c === 'string');
    root.set('colonne', seq);
  }

  if (config.larghezze && Object.keys(config.larghezze).length > 0) {
    const wNode = doc.createNode(config.larghezze) as YAML.YAMLMap;
    wNode.flow = true;
    root.set('larghezze', wNode);
  }

  if (config.ordina && config.ordina.length > 0) {
    const seq = new YAML.YAMLSeq();
    seq.flow = true;
    for (const s of config.ordina) {
      const m = doc.createNode({ proprieta: s.proprieta, direzione: s.direzione }) as YAML.YAMLMap;
      m.flow = true;
      seq.add(m);
    }
    root.set('ordina', seq);
  }

  if (config.filtri && config.filtri.length > 0) {
    const seq = new YAML.YAMLSeq();
    seq.flow = true;
    for (const f of config.filtri) {
      const obj: Record<string, unknown> = {
        proprieta: f.proprieta,
        operatore: f.operatore,
      };
      if (f.valore !== undefined && f.operatore !== 'vuoto' && f.operatore !== 'non-vuoto') {
        obj.valore = f.valore;
      }
      const m = doc.createNode(obj) as YAML.YAMLMap;
      m.flow = true;
      seq.add(m);
    }
    root.set('filtri', seq);
  }

  if (config.proprieta && config.proprieta.length > 0) {
    const serializedProps = serializePropertyDefinitions(config.proprieta);
    const propSeq = new YAML.YAMLSeq();
    for (const p of serializedProps) {
      const m = doc.createNode(p) as YAML.YAMLMap;
      m.flow = true;
      propSeq.add(m);
    }
    root.set('proprieta', propSeq);
  }

  const yamlStr = doc.toString({ lineWidth: 0 }).trimEnd();
  const blockLf = `\`\`\`vista\n${yamlStr}\n\`\`\``;
  return eol === '\r\n' ? blockLf.replace(/\r?\n/g, '\r\n') : blockLf;
}

export interface ExtractedVistaBlock {
  /** Indice 0-based del blocco vista/embed all'interno della pagina. */
  index: number;
  kind: 'vista' | 'legacy-embed';
  /** Offset di inizio nel testo passato a `extractVistaBlocks`. */
  fromOffset: number;
  /** Offset di fine nel testo passato a `extractVistaBlocks`. */
  toOffset: number;
  /** Riga di inizio (1-based). */
  startLine: number;
  /** Riga di fine (1-based). */
  endLine: number;
  /** Testo originale esatto del blocco (per round-trip byte-per-byte). */
  rawBlock: string;
  /** Contenuto interno YAML (per `kind === 'vista'`). */
  innerYaml: string;
  /** Esito del parsing. */
  parsed: VistaParseOutcome;
}

/**
 * Estrae tutti i blocchi ```vista ... ``` e i blocchi legacy `![[page:p_...]]` dal corpo Markdown
 * (o dall'intero documento, ignorando il frontmatter iniziale e altri blocchi di codice fenced).
 */
export function extractVistaBlocks(markdown: string): ExtractedVistaBlock[] {
  const blocks: ExtractedVistaBlock[] = [];
  const len = markdown.length;

  // Salta eventuale frontmatter YAML in testa al file
  let scanStart = 0;
  let currentLine = 1;
  const hasBom = markdown.startsWith('\uFEFF');
  const fmMatch = /^(?:\uFEFF)?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(
    markdown,
  );
  if (fmMatch) {
    scanStart = fmMatch[0].length;
    currentLine += (fmMatch[0].match(/\n/g) ?? []).length;
  } else if (hasBom) {
    scanStart = 1;
  }

  let pos = scanStart;
  let activeOuterFence: { char: string; count: number; isVista: boolean; startOffset: number; contentStart: number; startLine: number } | null = null;

  while (pos < len) {
    const nlIdx = markdown.indexOf('\n', pos);
    const lineEnd = nlIdx === -1 ? len : nlIdx + 1;
    const rawLineWithEol = markdown.slice(pos, lineEnd);
    const lineWithoutEol = rawLineWithEol.replace(/\r?\n$/, '');

    const fenceMatch = /^([ \t]{0,3})(`{3,}|~{3,})([ \t]*([^\r\n]*))?$/.exec(lineWithoutEol);

    if (activeOuterFence) {
      if (
        fenceMatch &&
        fenceMatch[2]![0] === activeOuterFence.char &&
        fenceMatch[2]!.length >= activeOuterFence.count &&
        (!fenceMatch[4] || fenceMatch[4].trim() === '')
      ) {
        if (activeOuterFence.isVista) {
          const blockEndOffset = pos + lineWithoutEol.length;
          const rawBlock = markdown.slice(activeOuterFence.startOffset, blockEndOffset);
          const innerYaml = markdown.slice(activeOuterFence.contentStart, pos);
          blocks.push({
            index: blocks.length,
            kind: 'vista',
            fromOffset: activeOuterFence.startOffset,
            toOffset: blockEndOffset,
            startLine: activeOuterFence.startLine,
            endLine: currentLine,
            rawBlock,
            innerYaml,
            parsed: parseVistaBlockYaml(innerYaml),
          });
        }
        activeOuterFence = null;
      }
    } else if (fenceMatch) {
      const fenceChars = fenceMatch[2]!;
      const infoString = (fenceMatch[4] ?? '').trim().toLowerCase();
      activeOuterFence = {
        char: fenceChars[0]!,
        count: fenceChars.length,
        isVista: infoString === 'vista',
        startOffset: pos,
        contentStart: lineEnd,
        startLine: currentLine,
      };
    } else {
      // Controlla se la riga è un incorporamento legacy ![[page:p_...]]
      const legacyMatch = /^[ \t]*!\[\[page:(p_[a-zA-Z0-9_-]+)\]\][ \t]*$/.exec(lineWithoutEol);
      if (legacyMatch) {
        const dbId = legacyMatch[1]!;
        const blockEndOffset = pos + lineWithoutEol.length;
        const rawBlock = markdown.slice(pos, blockEndOffset);
        const config: VistaBlockConfig = {
          fonte: `database ${dbId}`,
        };
        blocks.push({
          index: blocks.length,
          kind: 'legacy-embed',
          fromOffset: pos,
          toOffset: blockEndOffset,
          startLine: currentLine,
          endLine: currentLine,
          rawBlock,
          innerYaml: `fonte: database ${dbId}`,
          parsed: {
            ok: true,
            config,
            source: { type: 'database', targetId: dbId },
          },
        });
      }
    }

    pos = lineEnd;
    currentLine++;
  }

  return blocks;
}

/**
 * Sostituisce chirurgicamente il blocco `blockIndex` nel documento Markdown con la nuova
 * configurazione `VistaBlockConfig`, mantenendo byte-per-byte identico tutto il resto del file
 * (incluso un eventuale cambio da `![[page:p_...]]` a blocco ```vista``` quando si salva la vista).
 */
export function replaceVistaBlockInMarkdown(
  markdown: string,
  blockIndex: number,
  nextConfig: VistaBlockConfig,
): string {
  const eol: '\r\n' | '\n' = markdown.includes('\r\n') ? '\r\n' : '\n';
  const blocks = extractVistaBlocks(markdown);
  const target = blocks[blockIndex];
  if (!target) {
    throw badRequest(`Blocco vista #${blockIndex} non trovato nella pagina.`);
  }
  const serialized = serializeVistaBlock(nextConfig, eol);
  return (
    markdown.slice(0, target.fromOffset) +
    serialized +
    markdown.slice(target.toOffset)
  );
}
