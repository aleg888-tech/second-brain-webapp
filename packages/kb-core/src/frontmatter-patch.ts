import YAML, { isMap, isScalar, isSeq, Scalar, YAMLMap } from 'yaml';
import { badRequest } from './errors.js';

export interface SplitRawFrontmatter {
  hasFrontmatter: boolean;
  bom: string;
  openFence: string;
  innerYaml: string;
  closeFence: string;
  body: string;
  eol: '\r\n' | '\n';
}

export interface ParsedFrontmatterResult extends SplitRawFrontmatter {
  data: Record<string, unknown>;
  keyOrder: string[];
  errors: string[];
}

const RAW_FM_SPLIT_RE = /^(---[ \t]*\r?\n)([\s\S]*?\r?\n)?(---[ \t]*(?:\r?\n|$))/;

export function splitVerbatimFrontmatter(content: string): SplitRawFrontmatter {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const withoutBom = bom ? content.slice(1) : content;
  const eol: '\r\n' | '\n' = content.includes('\r\n') ? '\r\n' : '\n';

  const match = RAW_FM_SPLIT_RE.exec(withoutBom);
  if (!match) {
    return {
      hasFrontmatter: false,
      bom,
      openFence: '',
      innerYaml: '',
      closeFence: '',
      body: withoutBom,
      eol,
    };
  }

  const openFence = match[1]!;
  const innerYaml = match[2] ?? '';
  const closeFence = match[3]!;
  const body = withoutBom.slice(match[0].length);

  return {
    hasFrontmatter: true,
    bom,
    openFence,
    innerYaml,
    closeFence,
    body,
    eol,
  };
}

export function parseFrontmatterYaml(content: string): ParsedFrontmatterResult {
  const split = splitVerbatimFrontmatter(content);
  if (!split.hasFrontmatter || split.innerYaml.trim() === '') {
    return {
      ...split,
      data: {},
      keyOrder: [],
      errors: [],
    };
  }

  const doc = YAML.parseDocument(split.innerYaml, {
    keepSourceTokens: true,
    prettyErrors: false,
  });

  const errors = doc.errors.map((e) => e.message);
  if (!doc.contents || !isMap(doc.contents)) {
    return {
      ...split,
      data: {},
      keyOrder: [],
      errors,
    };
  }

  const js = doc.toJS({ maxAliasCount: 50 });
  const data =
    js && typeof js === 'object' && !Array.isArray(js) ? (js as Record<string, unknown>) : {};
  const keyOrder: string[] = [];
  for (const item of doc.contents.items) {
    if (isScalar(item.key) && item.key.value !== null && item.key.value !== undefined) {
      keyOrder.push(String(item.key.value));
    }
  }

  return {
    ...split,
    data,
    keyOrder,
    errors,
  };
}

function formatSinglePairYaml(
  key: string,
  value: unknown,
  eol: '\r\n' | '\n',
  preferredQuote?: Scalar.Type | null,
  preferredFlowSeq = true,
): string {
  const tempDoc = new YAML.Document({});
  const map = tempDoc.contents as YAMLMap;

  let node: unknown;
  if (
    typeof value === 'string' &&
    !value.includes('\n') &&
    !value.includes('\r') &&
    (preferredQuote === Scalar.QUOTE_DOUBLE || preferredQuote === Scalar.QUOTE_SINGLE)
  ) {
    const s = new Scalar(value);
    s.type = preferredQuote;
    node = s;
  } else if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
  ) {
    // Lista di definizioni (es. `proprieta:` dello schema database): ogni voce come flow map `- {chiave: ...}`
    const seq = new YAML.YAMLSeq();
    for (const item of value) {
      const itemMap = tempDoc.createNode(item) as YAMLMap;
      itemMap.flow = true;
      seq.add(itemMap);
    }
    node = seq;
  } else if (
    preferredFlowSeq &&
    Array.isArray(value) &&
    value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
  ) {
    const seq = tempDoc.createNode(value) as YAML.YAMLSeq;
    seq.flow = true;
    node = seq;
  } else {
    node = tempDoc.createNode(value);
  }

  map.set(tempDoc.createNode(key), node);
  const lfRendered = tempDoc.toString({
    lineWidth: 0,
    nullStr: '',
  });
  return eol === '\r\n' ? lfRendered.replace(/\r?\n/g, '\r\n') : lfRendered;
}

export interface PatchFrontmatterOptions {
  unset?: boolean;
  insertAtTop?: boolean;
}

/**
 * Esegue una PATCH chirurgica di una singola chiave nel frontmatter YAML usando `yaml` (CST/AST),
 * preservando ordine delle chiavi, commenti, stile delle virgolette, sequenze flow/block,
 * fine riga (LF / CRLF) e lasciando tutto il resto del file identico byte per byte.
 */
export function patchFrontmatterField(
  content: string,
  rawKey: string,
  value: unknown,
  opts: PatchFrontmatterOptions = {},
): string {
  const key = rawKey.trim();
  if (!key) {
    throw badRequest('Chiave del frontmatter mancante.');
  }

  const shouldUnset = Boolean(opts.unset || value === undefined);
  const split = splitVerbatimFrontmatter(content);
  const { eol, bom, body } = split;

  // 1. Nessun frontmatter esistente nel file
  if (!split.hasFrontmatter) {
    if (shouldUnset) return content;
    const pairBlock = formatSinglePairYaml(key, value, eol);
    const separator = body.length > 0 && !body.startsWith('\r') && !body.startsWith('\n') ? '' : '';
    return `${bom}---${eol}${pairBlock}---${eol}${separator}${body}`;
  }

  const { openFence, innerYaml, closeFence } = split;
  const doc = YAML.parseDocument(innerYaml, {
    keepSourceTokens: true,
    prettyErrors: false,
  });

  if (doc.errors.length > 0) {
    throw badRequest(`Frontmatter YAML non valido: ${doc.errors[0]!.message}`);
  }

  if (doc.contents && !isMap(doc.contents)) {
    throw badRequest('Il frontmatter YAML deve essere una mappa chiave-valore.');
  }

  const items = isMap(doc.contents) ? doc.contents.items : [];
  const existingPair = items.find(
    (p) => isScalar(p.key) && String(p.key.value ?? '') === key,
  );

  // 2. Chiave non ancora presente nel frontmatter
  if (!existingPair) {
    if (shouldUnset) return content;
    const pairBlock = formatSinglePairYaml(key, value, eol);
    if (innerYaml === '') {
      return `${bom}${openFence}${pairBlock}${closeFence}${body}`;
    }
    if (opts.insertAtTop) {
      return `${bom}${openFence}${pairBlock}${innerYaml}${closeFence}${body}`;
    }
    const needsNewline = !innerYaml.endsWith('\n');
    const nextInner = `${innerYaml}${needsNewline ? eol : ''}${pairBlock}`;
    return `${bom}${openFence}${nextInner}${closeFence}${body}`;
  }

  // 3. Chiave già presente: individua lo span esatto della coppia in innerYaml
  const keyRange = (existingPair.key as { range?: [number, number, number] }).range;
  if (!keyRange) {
    throw badRequest('Impossibile determinare la posizione della chiave nel frontmatter.');
  }

  // Risale all'inizio della riga della chiave (eventuale indentazione)
  let pairLineStart = keyRange[0];
  while (
    pairLineStart > 0 &&
    (innerYaml[pairLineStart - 1] === ' ' || innerYaml[pairLineStart - 1] === '\t')
  ) {
    pairLineStart--;
  }

  const valNode = existingPair.value as
    | { range?: [number, number, number]; type?: Scalar.Type; flow?: boolean }
    | null
    | undefined;
  const valRange = valNode?.range;

  // Rimozione chiave (unset)
  if (shouldUnset) {
    let removeEnd = valRange ? valRange[2] : keyRange[2];
    if (removeEnd === 0 || innerYaml[removeEnd - 1] !== '\n') {
      const tailMatch = /^[ \t]*(?:#[^\r\n]*)?\r?\n/.exec(innerYaml.slice(removeEnd));
      if (tailMatch) {
        removeEnd += tailMatch[0].length;
      }
    }
    const nextInner = innerYaml.slice(0, pairLineStart) + innerYaml.slice(removeEnd);
    if (nextInner.trim() === '' && !nextInner.includes('#')) {
      return `${bom}${body}`;
    }
    return `${bom}${openFence}${nextInner}${closeFence}${body}`;
  }

  const preferredQuote =
    isScalar(existingPair.value) &&
    (existingPair.value.type === Scalar.QUOTE_DOUBLE ||
      existingPair.value.type === Scalar.QUOTE_SINGLE)
      ? existingPair.value.type
      : null;

  const preferredFlowSeq = isSeq(existingPair.value) ? Boolean(existingPair.value.flow) : true;

  const formattedPairWithEol = formatSinglePairYaml(
    key,
    value,
    eol,
    preferredQuote,
    preferredFlowSeq,
  );
  const formattedTrimmed = formattedPairWithEol.endsWith('\r\n')
    ? formattedPairWithEol.slice(0, -2)
    : formattedPairWithEol.endsWith('\n')
      ? formattedPairWithEol.slice(0, -1)
      : formattedPairWithEol;
  const isNewValueSingleLine = !formattedTrimmed.includes('\n');

  // Se il valore esistente era scalare/flow su singola riga e anche il nuovo valore è su singola riga,
  // sostituisce solo [pairLineStart .. valRange[1]], lasciando intatti eventuali commenti inline (es. "   # nota\r\n")!
  if (
    valRange &&
    valRange[1] > valRange[0] &&
    !innerYaml.slice(keyRange[0], valRange[1]).includes('\n') &&
    isNewValueSingleLine
  ) {
    const indent = innerYaml.slice(pairLineStart, keyRange[0]);
    const nextInner =
      innerYaml.slice(0, pairLineStart) +
      indent +
      formattedTrimmed +
      innerYaml.slice(valRange[1]);
    return `${bom}${openFence}${nextInner}${closeFence}${body}`;
  }

  // Caso valore vuoto su singola riga (es. `vuoto:   # commento\r\n`): preserva eventuale commento inline
  if (
    valRange &&
    valRange[1] === valRange[0] &&
    !innerYaml.slice(keyRange[0], valRange[1]).includes('\n') &&
    isNewValueSingleLine &&
    innerYaml[valRange[1]] === '#'
  ) {
    const indent = innerYaml.slice(pairLineStart, keyRange[0]);
    const wsBeforeHash =
      /[ \t]+$/.exec(innerYaml.slice(keyRange[2] + 1, valRange[1]))?.[0] ?? ' ';
    const nextInner =
      innerYaml.slice(0, pairLineStart) +
      indent +
      formattedTrimmed +
      wsBeforeHash +
      innerYaml.slice(valRange[1]);
    return `${bom}${openFence}${nextInner}${closeFence}${body}`;
  }

  // Altrimenti (lista a blocchi, mappa annidata, o transizione singola <-> multilinea):
  // se `replaceEnd` termina già con `\n` (come nelle sequenze a blocchi), NON consumare la riga successiva!
  let replaceEnd = valRange ? valRange[2] : keyRange[2];
  let inlineComment = '';
  if (replaceEnd === 0 || innerYaml[replaceEnd - 1] !== '\n') {
    const tailAfterEnd = /^[ \t]*(#[^\r\n]*)?\r?\n/.exec(innerYaml.slice(replaceEnd));
    if (tailAfterEnd) {
      if (tailAfterEnd[1] && isNewValueSingleLine) {
        const wsBeforeComment = /^[ \t]+/.exec(tailAfterEnd[0])?.[0] ?? ' ';
        inlineComment = `${wsBeforeComment}${tailAfterEnd[1]}`;
      }
      replaceEnd += tailAfterEnd[0].length;
    }
  }

  const indent = innerYaml.slice(pairLineStart, keyRange[0]);
  const replacement = isNewValueSingleLine
    ? `${indent}${formattedTrimmed}${inlineComment}${eol}`
    : formattedPairWithEol;

  const nextInner =
    innerYaml.slice(0, pairLineStart) + replacement + innerYaml.slice(replaceEnd);
  return `${bom}${openFence}${nextInner}${closeFence}${body}`;
}
