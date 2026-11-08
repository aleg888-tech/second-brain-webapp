import YAML, { isMap, isScalar, isSeq, Scalar, YAMLMap } from 'yaml';

export interface Frontmatter {
  id?: string;
  titolo?: string;
  creato?: string;
  tag?: string[];
  tipo?: string;
  icona?: string;
  copertina?: string;
  esempio?: boolean;
  [key: string]: unknown;
}

export interface SplitDocument {
  frontmatter: Frontmatter | null;
  /** Contenuto interno tra i due delimitatori `---` (senza i delimitatori). */
  rawFrontmatter: string;
  /** Prefisso esatto byte-per-byte dall'inizio del file fino alla fine della riga di chiusura `---` (incluso BOM e fine riga). */
  rawPrefix: string;
  /** Corpo esatto del documento dopo `rawPrefix`, senza rimozione di righe vuote o alterazioni. */
  body: string;
  eol: '\r\n' | '\n';
  keyOrder: string[];
  errors: string[];
}

const RAW_FM_SPLIT_RE = /^(---[ \t]*\r?\n)([\s\S]*?\r?\n)?(---[ \t]*(?:\r?\n|$))/;

export function parseFrontmatter(content: string): SplitDocument {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const withoutBom = bom ? content.slice(1) : content;
  const eol: '\r\n' | '\n' = content.includes('\r\n') ? '\r\n' : '\n';

  const match = RAW_FM_SPLIT_RE.exec(withoutBom);
  if (!match) {
    return {
      frontmatter: null,
      rawFrontmatter: '',
      rawPrefix: bom,
      body: withoutBom,
      eol,
      keyOrder: [],
      errors: [],
    };
  }

  const fullFenceBlock = match[0]!;
  const rawInner = match[2] ?? '';
  const rawFrontmatter = rawInner.replace(/\r?\n$/, '');
  const rawPrefix = bom + fullFenceBlock;
  const body = withoutBom.slice(fullFenceBlock.length);

  if (rawInner.trim() === '') {
    return {
      frontmatter: {},
      rawFrontmatter: '',
      rawPrefix,
      body,
      eol,
      keyOrder: [],
      errors: [],
    };
  }

  const doc = YAML.parseDocument(rawInner, {
    keepSourceTokens: true,
    prettyErrors: false,
  });

  const errors = doc.errors.map((e) => e.message);
  if (!doc.contents || !isMap(doc.contents)) {
    return {
      frontmatter: {},
      rawFrontmatter,
      rawPrefix,
      body,
      eol,
      keyOrder: [],
      errors,
    };
  }

  const js = doc.toJS({ maxAliasCount: 50 });
  const data: Frontmatter =
    js && typeof js === 'object' && !Array.isArray(js) ? (js as Frontmatter) : {};

  // Compatibilità con test/viste: se `tag` è una singola stringa, normalizza in array in lettura
  if (data.tag !== undefined && data.tag !== null && !Array.isArray(data.tag)) {
    if (typeof data.tag === 'string') {
      data.tag = [data.tag];
    }
  }

  const keyOrder: string[] = [];
  for (const item of doc.contents.items) {
    if (isScalar(item.key) && item.key.value !== null && item.key.value !== undefined) {
      keyOrder.push(String(item.key.value));
    }
  }

  return {
    frontmatter: data,
    rawFrontmatter,
    rawPrefix,
    body,
    eol,
    keyOrder,
    errors,
  };
}

function formatYamlKey(key: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(key)) return key;
  return JSON.stringify(key);
}

function formatSinglePairYaml(
  key: string,
  value: unknown,
  eol: '\r\n' | '\n',
  preferredQuote?: Scalar.Type | null,
  preferredFlowSeq?: boolean,
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
    preferredFlowSeq &&
    Array.isArray(value) &&
    value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
  ) {
    const formattedItems = value.map((item) => {
      const itemDoc = new YAML.Document(item);
      return itemDoc.toString({ lineWidth: 0 }).trim();
    });
    return `${formatYamlKey(key)}: [${formattedItems.join(', ')}]${eol}`;
  } else {
    node = tempDoc.createNode(value);
  }

  map.set(tempDoc.createNode(key), node);
  const lfRendered = tempDoc.toString({ lineWidth: 0, nullStr: '' });
  return eol === '\r\n' ? lfRendered.replace(/\r?\n/g, '\r\n') : lfRendered;
}

export function patchFrontmatterInMemory(
  content: string,
  rawKey: string,
  value: unknown,
  unset = false,
): string {
  const key = rawKey.trim();
  if (!key) return content;

  const shouldUnset = Boolean(unset || value === undefined);
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const withoutBom = bom ? content.slice(1) : content;
  const eol: '\r\n' | '\n' = content.includes('\r\n') ? '\r\n' : '\n';

  const match = RAW_FM_SPLIT_RE.exec(withoutBom);
  if (!match) {
    if (shouldUnset) return content;
    const pairBlock = formatSinglePairYaml(key, value, eol);
    return `${bom}---${eol}${pairBlock}---${eol}${withoutBom}`;
  }

  const openFence = match[1]!;
  const innerYaml = match[2] ?? '';
  const closeFence = match[3]!;
  const body = withoutBom.slice(match[0].length);

  const doc = YAML.parseDocument(innerYaml, { keepSourceTokens: true, prettyErrors: false });
  if (doc.errors.length > 0 || (doc.contents && !isMap(doc.contents))) {
    return content;
  }

  const items = isMap(doc.contents) ? doc.contents.items : [];
  const existingPair = items.find((p) => isScalar(p.key) && String(p.key.value ?? '') === key);

  if (!existingPair) {
    if (shouldUnset) return content;
    const pairBlock = formatSinglePairYaml(key, value, eol);
    const needsNewline = innerYaml !== '' && !innerYaml.endsWith('\n');
    return `${bom}${openFence}${innerYaml}${needsNewline ? eol : ''}${pairBlock}${closeFence}${body}`;
  }

  const keyRange = (existingPair.key as { range?: [number, number, number] }).range;
  if (!keyRange) return content;

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

  if (shouldUnset) {
    let removeEnd = valRange ? valRange[2] : keyRange[2];
    if (removeEnd === 0 || innerYaml[removeEnd - 1] !== '\n') {
      const tailMatch = /^[ \t]*(?:#[^\r\n]*)?\r?\n/.exec(innerYaml.slice(removeEnd));
      if (tailMatch) removeEnd += tailMatch[0].length;
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
  const preferredFlowSeq = Boolean(isSeq(existingPair.value) && existingPair.value.flow);

  const formattedPairWithEol = formatSinglePairYaml(
    key,
    value,
    eol,
    preferredQuote,
    preferredFlowSeq,
  );
  const formattedTrimmed = formattedPairWithEol.replace(/\r?\n$/, '');
  const isNewValueSingleLine = !formattedTrimmed.includes('\n');

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

  let replaceEnd = valRange ? valRange[2] : keyRange[2];
  let inlineComment = '';
  if (replaceEnd === 0 || innerYaml[replaceEnd - 1] !== '\n') {
    const tailAfterEnd = /^[ \t]*(#[^\r\n]*)?\r?\n/.exec(innerYaml.slice(replaceEnd));
    if (tailAfterEnd) {
      if (tailAfterEnd[1] && isNewValueSingleLine) {
        const ws = /^[ \t]+/.exec(tailAfterEnd[0])?.[0] ?? ' ';
        inlineComment = `${ws}${tailAfterEnd[1]}`;
      }
      replaceEnd += tailAfterEnd[0].length;
    }
  }

  const indent = innerYaml.slice(pairLineStart, keyRange[0]);
  const replacement = isNewValueSingleLine
    ? `${indent}${formattedTrimmed}${inlineComment}${eol}`
    : formattedPairWithEol;

  const nextInner = innerYaml.slice(0, pairLineStart) + replacement + innerYaml.slice(replaceEnd);
  return `${bom}${openFence}${nextInner}${closeFence}${body}`;
}
