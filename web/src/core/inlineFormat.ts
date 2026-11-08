export type InlineStyle = 'bold' | 'italic' | 'strike' | 'code';

export interface CharCell {
  ch: string;
  origFrom: number;
  origTo: number;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  atomic: boolean;
}

export interface ParsedLink {
  type: 'wikilink' | 'mdlink' | 'autolink';
  from: number;
  to: number;
  raw: string;
  target: string;
  label: string;
  rawLabel: string;
  labelFrom: number;
  labelTo: number;
  visibleFrom: number;
  visibleTo: number;
  isExternal: boolean;
  standalone: boolean;
  bold: boolean;
  italic: boolean;
  strike: boolean;
}

export interface ParsedInlineLine {
  isHr: boolean;
  prefixLen: number;
  hiddenRanges: Array<{ from: number; to: number }>;
  links: ParsedLink[];
  cells: CharCell[];
}

type Segment =
  | { type: 'text'; from: number; to: number; text: string }
  | {
      type: 'code';
      openFrom: number;
      openTo: number;
      contentFrom: number;
      contentTo: number;
      closeFrom: number;
      closeTo: number;
      text: string;
    }
  | {
      type: 'wikilink';
      from: number;
      to: number;
      raw: string;
      target: string;
      label: string;
    }
  | {
      type: 'mdlink';
      from: number;
      to: number;
      raw: string;
      target: string;
      label: string;
      rawLabel: string;
      isExternal: boolean;
      standalone: boolean;
    }
  | {
      type: 'autolink';
      from: number;
      to: number;
      raw: string;
      target: string;
      label: string;
    }
  | {
      type: 'delim';
      char: '*' | '~';
      from: number;
      to: number;
      availFrom: number;
      availTo: number;
      origCount: number;
      canOpen: boolean;
      canClose: boolean;
    };

interface EmphSpan {
  style: 'bold' | 'italic' | 'strike';
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
}

export const BLOCK_PREFIX_RE =
  /^(#{1,6}\s+|\s*-\s+\[[ xX]\]\s*|\s*[-*]\s+|\s*\d+[.)]\s+|>\s*)/;

function mergeRanges(ranges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const valid = ranges.filter((r) => r.to > r.from).sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const r of valid) {
    const prev = merged[merged.length - 1];
    if (prev && r.from <= prev.to) {
      prev.to = Math.max(prev.to, r.to);
    } else {
      merged.push({ from: r.from, to: r.to });
    }
  }
  return merged;
}

export function formatStandaloneUrlLabel(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (/^mailto:/i.test(trimmed)) {
    return trimmed.replace(/^mailto:/i, '');
  }
  let clean = trimmed.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  if (!clean) clean = trimmed;
  if (clean.length > 56) {
    clean = `${clean.slice(0, 55)}…`;
  }
  return clean;
}

function trimTrailingUrlPunctuation(rawUrl: string): string {
  let end = rawUrl.length;
  while (end > 0) {
    const ch = rawUrl[end - 1]!;
    if (/[.,;:!?'"\]>*~]/.test(ch)) {
      end--;
      continue;
    }
    if (ch === ')') {
      const slice = rawUrl.slice(0, end);
      const opens = (slice.match(/\(/g) || []).length;
      const closes = (slice.match(/\)/g) || []).length;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return rawUrl.slice(0, end);
}

export function normalizeExternalUrl(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return '';
  if (/^(https?:\/\/|mailto:|ftp:\/\/)/i.test(trimmed)) return trimmed;
  if (/^www\./i.test(trimmed) || /^[^/\s]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/**
 * Analizza il contenuto inline di una singola riga Markdown separando
 * prefisso di blocco, delimitatori nascosti (**, *, ~~, `), link e caratteri visibili.
 */
export function parseInlineLine(lineText: string, lineFrom = 0): ParsedInlineLine {
  if (/^\s*---+\s*$/.test(lineText)) {
    return {
      isHr: true,
      prefixLen: lineText.length,
      hiddenRanges: [],
      links: [],
      cells: [],
    };
  }

  const pm = lineText.match(BLOCK_PREFIX_RE);
  const prefixLen = pm ? pm[0].length : 0;
  const src = lineText.slice(prefixLen);
  const base = lineFrom + prefixLen;

  const segments: Segment[] = [];
  let i = 0;

  while (i < src.length) {
    // 1. Wikilink [[target]] / [[target#sez|alias]] (esclude incorporamenti ![[...]])
    if (src[i] === '[' && src[i + 1] === '[' && !(i > 0 && src[i - 1] === '!')) {
      const wm = src.slice(i).match(/^\[\[([^\]|#\n]+)(?:#[^\]|\n]+)?(?:\|([^\]\n]+))?\]\]/);
      if (wm) {
        const raw = wm[0];
        const target = wm[1]!.trim();
        const alias = wm[2]?.trim();
        segments.push({
          type: 'wikilink',
          from: i,
          to: i + raw.length,
          raw,
          target,
          label: alias || target,
        });
        i += raw.length;
        continue;
      }
    }

    // 2. Link Markdown [testo](url) o [Titolo Meta](url "preview")
    if (src[i] === '[') {
      const lm = src
        .slice(i)
        .match(/^\[([^\]\n]+)\]\(((?:\([^)\s\n"]*?\)|[^)\s\n"]+)+)(?:\s+"([^"\n]*)")?\)/);
      if (lm) {
        const raw = lm[0];
        const rawLabelSlice = lm[1]!;
        const rawLabel = rawLabelSlice.trim();
        const url = lm[2]!.trim();
        const linkAttr = lm[3]?.trim().toLowerCase();
        const isExternal = /^(https?:\/\/|mailto:|ftp:\/\/)/i.test(url);
        const target = isExternal ? url : url.replace(/\.md$/, '');
        const isLabelBareUrl = isExternal && /^(https?:\/\/|www\.|mailto:)/i.test(rawLabel);
        const isPreviewAttr = isExternal && linkAttr === 'preview';
        segments.push({
          type: 'mdlink',
          from: i,
          to: i + raw.length,
          raw,
          target,
          label: isLabelBareUrl ? formatStandaloneUrlLabel(rawLabel) : rawLabel,
          rawLabel: rawLabelSlice,
          isExternal,
          standalone: isLabelBareUrl || isPreviewAttr,
        });
        i += raw.length;
        continue;
      }
    }

    // 2b. Autolink racchiuso tra parentesi angolari <https://...>
    if (src[i] === '<') {
      const am = src.slice(i).match(/^<(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)>/i);
      if (am) {
        const raw = am[0];
        const url = am[1]!.trim();
        segments.push({
          type: 'autolink',
          from: i,
          to: i + raw.length,
          raw,
          target: url,
          label: formatStandaloneUrlLabel(url),
        });
        i += raw.length;
        continue;
      }
    }

    // 2c. URL esterno semplice incollato direttamente (https://... o http://...)
    if (
      (src[i] === 'h' || src[i] === 'H') &&
      (i === 0 || /[\s([<*"'~]/.test(src[i - 1]!)) &&
      /^https?:\/\/[^\s<>[\]`]+/i.test(src.slice(i))
    ) {
      const bm = src.slice(i).match(/^https?:\/\/[^\s<>[\]`]+/i)!;
      const cleanUrl = trimTrailingUrlPunctuation(bm[0]);
      if (/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(cleanUrl) || /^https?:\/\/localhost\b/i.test(cleanUrl)) {
        segments.push({
          type: 'autolink',
          from: i,
          to: i + cleanUrl.length,
          raw: cleanUrl,
          target: cleanUrl,
          label: formatStandaloneUrlLabel(cleanUrl),
        });
        i += cleanUrl.length;
        continue;
      }
    }

    // 3. Codice inline `...`
    if (src[i] === '`') {
      let tickLen = 0;
      while (i + tickLen < src.length && src[i + tickLen] === '`') {
        tickLen++;
      }
      let closeIdx = -1;
      let searchPos = i + tickLen;
      while (searchPos < src.length) {
        const nextTick = src.indexOf('`', searchPos);
        if (nextTick === -1) break;
        let closeRun = 0;
        while (nextTick + closeRun < src.length && src[nextTick + closeRun] === '`') {
          closeRun++;
        }
        if (closeRun === tickLen && nextTick > i + tickLen) {
          closeIdx = nextTick;
          break;
        }
        searchPos = nextTick + closeRun;
      }

      if (closeIdx !== -1) {
        segments.push({
          type: 'code',
          openFrom: i,
          openTo: i + tickLen,
          contentFrom: i + tickLen,
          contentTo: closeIdx,
          closeFrom: closeIdx,
          closeTo: closeIdx + tickLen,
          text: src.slice(i + tickLen, closeIdx),
        });
        i = closeIdx + tickLen;
        continue;
      } else {
        segments.push({
          type: 'text',
          from: i,
          to: i + tickLen,
          text: src.slice(i, i + tickLen),
        });
        i += tickLen;
        continue;
      }
    }

    // 4. Delimitatori barrato ~~
    if (src[i] === '~') {
      let len = 0;
      while (i + len < src.length && src[i + len] === '~') {
        len++;
      }
      if (len >= 2) {
        const prevCh = i > 0 ? src[i - 1] : undefined;
        const nextCh = i + len < src.length ? src[i + len] : undefined;
        const canOpen = nextCh !== undefined && !/\s/.test(nextCh);
        const canClose = prevCh !== undefined && !/\s/.test(prevCh);
        segments.push({
          type: 'delim',
          char: '~',
          from: i,
          to: i + len,
          availFrom: i,
          availTo: i + len,
          origCount: len,
          canOpen,
          canClose,
        });
      } else {
        segments.push({
          type: 'text',
          from: i,
          to: i + len,
          text: src.slice(i, i + len),
        });
      }
      i += len;
      continue;
    }

    // 5. Delimitatori asterisco (*, **, ***, ecc.)
    if (src[i] === '*') {
      let len = 0;
      while (i + len < src.length && src[i + len] === '*') {
        len++;
      }
      const prevCh = i > 0 ? src[i - 1] : undefined;
      const nextCh = i + len < src.length ? src[i + len] : undefined;
      const canOpen = nextCh !== undefined && !/\s/.test(nextCh);
      const canClose = prevCh !== undefined && !/\s/.test(prevCh);
      segments.push({
        type: 'delim',
        char: '*',
        from: i,
        to: i + len,
        availFrom: i,
        availTo: i + len,
        origCount: len,
        canOpen,
        canClose,
      });
      i += len;
      continue;
    }

    // 6. Testo semplice
    let end = i + 1;
    while (
      end < src.length &&
      src[end] !== '[' &&
      src[end] !== '<' &&
      src[end] !== '`' &&
      src[end] !== '~' &&
      src[end] !== '*' &&
      !((src[end] === 'h' || src[end] === 'H') && /^https?:\/\//i.test(src.slice(end)))
    ) {
      end++;
    }
    segments.push({
      type: 'text',
      from: i,
      to: end,
      text: src.slice(i, end),
    });
    i = end;
  }

  // Accoppiamento delimitatori CommonMark (gestisce *, **, ***, ****, ~~ e annidamenti)
  const spans: EmphSpan[] = [];
  for (let cIdx = 0; cIdx < segments.length; cIdx++) {
    const closer = segments[cIdx]!;
    if (closer.type !== 'delim' || !closer.canClose) continue;

    while (closer.availTo - closer.availFrom > 0) {
      const closerAvail = closer.availTo - closer.availFrom;
      if (closer.char === '~' && closerAvail < 2) break;

      let matchedOpenerIdx = -1;
      for (let oIdx = cIdx - 1; oIdx >= 0; oIdx--) {
        const opener = segments[oIdx]!;
        if (opener.type !== 'delim' || opener.char !== closer.char || !opener.canOpen) continue;
        const openerAvail = opener.availTo - opener.availFrom;
        if (opener.char === '~' && openerAvail < 2) continue;
        if (openerAvail <= 0) continue;
        if (closer.availFrom <= opener.availTo) continue;

        if (
          closer.char === '*' &&
          ((opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose)) &&
          (opener.origCount + closer.origCount) % 3 === 0 &&
          (opener.origCount % 3 !== 0 || closer.origCount % 3 !== 0)
        ) {
          continue;
        }

        matchedOpenerIdx = oIdx;
        break;
      }

      if (matchedOpenerIdx === -1) break;

      const opener = segments[matchedOpenerIdx] as Extract<Segment, { type: 'delim' }>;
      const openerAvail = opener.availTo - opener.availFrom;

      if (closer.char === '~') {
        const openFrom = opener.availTo - 2;
        const openTo = opener.availTo;
        const closeFrom = closer.availFrom;
        const closeTo = closer.availFrom + 2;
        opener.availTo -= 2;
        closer.availFrom += 2;
        spans.push({ style: 'strike', openFrom, openTo, closeFrom, closeTo });
      } else {
        const useCount = openerAvail >= 2 && closerAvail >= 2 ? 2 : 1;
        const openFrom = opener.availTo - useCount;
        const openTo = opener.availTo;
        const closeFrom = closer.availFrom;
        const closeTo = closer.availFrom + useCount;
        opener.availTo -= useCount;
        closer.availFrom += useCount;
        spans.push({
          style: useCount === 2 ? 'bold' : 'italic',
          openFrom,
          openTo,
          closeFrom,
          closeTo,
        });
      }

      for (let mIdx = matchedOpenerIdx + 1; mIdx < cIdx; mIdx++) {
        const mid = segments[mIdx]!;
        if (mid.type === 'delim') {
          mid.canOpen = false;
        }
      }
    }
  }

  const rawHidden: Array<{ from: number; to: number }> = [];
  for (const sp of spans) {
    rawHidden.push({ from: base + sp.openFrom, to: base + sp.openTo });
    rawHidden.push({ from: base + sp.closeFrom, to: base + sp.closeTo });
  }

  const stylesAt = (relFrom: number, relTo: number) => ({
    bold: spans.some((s) => s.style === 'bold' && relFrom >= s.openTo && relTo <= s.closeFrom),
    italic: spans.some((s) => s.style === 'italic' && relFrom >= s.openTo && relTo <= s.closeFrom),
    strike: spans.some((s) => s.style === 'strike' && relFrom >= s.openTo && relTo <= s.closeFrom),
  });

  const links: ParsedLink[] = [];
  const cells: CharCell[] = [];

  for (const seg of segments) {
    if (seg.type === 'text') {
      for (let k = 0; k < seg.text.length; k++) {
        const relPos = seg.from + k;
        cells.push({
          ch: seg.text[k]!,
          origFrom: base + relPos,
          origTo: base + relPos + 1,
          ...stylesAt(relPos, relPos + 1),
          code: false,
          atomic: false,
        });
      }
    } else if (seg.type === 'delim') {
      for (let relPos = seg.availFrom; relPos < seg.availTo; relPos++) {
        cells.push({
          ch: seg.char,
          origFrom: base + relPos,
          origTo: base + relPos + 1,
          ...stylesAt(relPos, relPos + 1),
          code: false,
          atomic: false,
        });
      }
    } else if (seg.type === 'code') {
      rawHidden.push({ from: base + seg.openFrom, to: base + seg.openTo });
      rawHidden.push({ from: base + seg.closeFrom, to: base + seg.closeTo });
      const outer = stylesAt(seg.openFrom, seg.closeTo);
      for (let k = 0; k < seg.text.length; k++) {
        const relPos = seg.contentFrom + k;
        cells.push({
          ch: seg.text[k]!,
          origFrom: base + relPos,
          origTo: base + relPos + 1,
          ...outer,
          code: true,
          atomic: false,
        });
      }
    } else if (seg.type === 'wikilink' || seg.type === 'mdlink' || seg.type === 'autolink') {
      const isExternal =
        seg.type === 'autolink' ? true : seg.type === 'mdlink' ? seg.isExternal : false;
      const standalone =
        seg.type === 'autolink' ? true : seg.type === 'mdlink' ? seg.standalone : false;
      const st = stylesAt(seg.from, seg.to);

      const absFrom = base + seg.from;
      const absTo = base + seg.to;
      let labelFrom = absFrom;
      let labelTo = absTo;
      let visibleFrom = absFrom;
      let visibleTo = absTo;
      let rawLabel = seg.label;

      if (seg.type === 'mdlink') {
        rawLabel = seg.rawLabel;
        labelFrom = absFrom + 1;
        labelTo = labelFrom + seg.rawLabel.length;
        if (standalone && /^(https?:\/\/|www\.|mailto:)/i.test(seg.rawLabel)) {
          const pm2 = seg.rawLabel.match(/^(https?:\/\/(?:www\.)?|www\.|mailto:)/i);
          const pLen = pm2 ? pm2[0].length : 0;
          const rest = seg.rawLabel.slice(pLen);
          const sm2 = rest.length > 1 ? rest.match(/(\/)$/) : null;
          const sLen = sm2 ? sm2[0].length : 0;
          visibleFrom = labelFrom + pLen;
          visibleTo = labelTo - sLen;
        } else {
          visibleFrom = labelFrom;
          visibleTo = labelTo;
        }
      } else if (seg.type === 'autolink') {
        rawLabel = seg.label;
        const pm2 = seg.raw.match(/^(<?https?:\/\/(?:www\.)?|<?mailto:)/i);
        const pLen = pm2 ? pm2[0].length : 0;
        const rest = seg.raw.slice(pLen);
        const sm2 = rest.length > 1 ? rest.match(/(\/?>|>|\/)$/) : null;
        const sLen = sm2 ? sm2[0].length : 0;
        visibleFrom = absFrom + pLen;
        visibleTo = absTo - sLen;
      }

      if (visibleTo <= visibleFrom) {
        visibleFrom = labelFrom;
        visibleTo = labelTo;
      }

      links.push({
        type: seg.type,
        from: absFrom,
        to: absTo,
        raw: seg.raw,
        target: seg.target,
        label: seg.label,
        rawLabel,
        labelFrom,
        labelTo,
        visibleFrom,
        visibleTo,
        isExternal,
        standalone,
        ...st,
      });
      cells.push({
        ch: seg.raw,
        origFrom: absFrom,
        origTo: absTo,
        ...st,
        code: false,
        atomic: true,
      });
    }
  }

  return {
    isHr: false,
    prefixLen,
    hiddenRanges: mergeRanges(rawHidden),
    links,
    cells,
  };
}

function normalizeWhitespaceRuns(cells: CharCell[]): void {
  const styles: InlineStyle[] = ['strike', 'bold', 'italic', 'code'];
  for (const st of styles) {
    let i = 0;
    while (i < cells.length) {
      if (!cells[i]![st]) {
        i++;
        continue;
      }
      let rStart = i;
      let rEnd = i;
      while (rEnd + 1 < cells.length && cells[rEnd + 1]![st]) {
        rEnd++;
      }
      const nextIdx = rEnd + 1;

      while (rStart <= rEnd && !cells[rStart]!.atomic && /^\s+$/.test(cells[rStart]!.ch)) {
        cells[rStart]![st] = false;
        rStart++;
      }
      while (rEnd >= rStart && !cells[rEnd]!.atomic && /^\s+$/.test(cells[rEnd]!.ch)) {
        cells[rEnd]![st] = false;
        rEnd--;
      }

      i = nextIdx;
    }
  }
}

function serializeCells(cells: CharCell[]): {
  text: string;
  offsets: Array<{ from: number; to: number }>;
} {
  normalizeWhitespaceRuns(cells);

  const markerFor = (st: InlineStyle): string => {
    switch (st) {
      case 'bold':
        return '**';
      case 'italic':
        return '*';
      case 'strike':
        return '~~';
      case 'code':
        return '`';
    }
  };

  const runEndFrom = (startIdx: number, st: InlineStyle): number => {
    let j = startIdx;
    while (j < cells.length && cells[j]![st]) {
      j++;
    }
    return j;
  };

  const styleOrder: InlineStyle[] = ['strike', 'bold', 'italic', 'code'];
  const stack: InlineStyle[] = [];
  const offsets: Array<{ from: number; to: number }> = [];
  let out = '';

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    const want = styleOrder.filter((st) => cell[st]);

    let closeFromIdx = -1;
    for (let k = 0; k < stack.length; k++) {
      const openSt = stack[k]!;
      if (!want.includes(openSt)) {
        closeFromIdx = k;
        break;
      }
      if (openSt === 'code') {
        const hasNewOuter = want.some((w) => w !== 'code' && !stack.slice(0, k).includes(w));
        if (hasNewOuter) {
          closeFromIdx = k;
          break;
        }
      }
    }

    if (closeFromIdx !== -1) {
      for (let k = stack.length - 1; k >= closeFromIdx; k--) {
        out += markerFor(stack[k]!);
      }
      stack.length = closeFromIdx;
    }

    const toOpen = want.filter((st) => !stack.includes(st));
    toOpen.sort((a, b) => {
      if (a === 'code') return 1;
      if (b === 'code') return -1;
      const diff = runEndFrom(i, b) - runEndFrom(i, a);
      if (diff !== 0) return diff;
      return styleOrder.indexOf(a) - styleOrder.indexOf(b);
    });

    for (const st of toOpen) {
      out += markerFor(st);
      stack.push(st);
    }

    const from = out.length;
    out += cell.ch;
    const to = out.length;
    offsets.push({ from, to });
  }

  for (let k = stack.length - 1; k >= 0; k--) {
    out += markerFor(stack[k]!);
  }

  return { text: out, offsets };
}

interface LineRecord {
  index: number;
  from: number;
  to: number;
  text: string;
}

function splitDocLines(docText: string): LineRecord[] {
  const rawLines = docText.split('\n');
  const records: LineRecord[] = [];
  let pos = 0;
  for (let idx = 0; idx < rawLines.length; idx++) {
    const text = rawLines[idx]!;
    records.push({
      index: idx,
      from: pos,
      to: pos + text.length,
      text,
    });
    pos += text.length + 1;
  }
  return records;
}

/**
 * Attiva o disattiva in modo idempotente uno stile inline ('bold', 'italic', 'strike', 'code')
 * mantenendo la selezione esattamente sul testo visibile (mai doppi asterischi).
 */
export function toggleInlineStyleOnDoc(
  docText: string,
  selFrom: number,
  selTo: number,
  style: InlineStyle,
): { text: string; from: number; to: number } {
  const lines = splitDocLines(docText);
  if (lines.length === 0) {
    return { text: docText, from: selFrom, to: selTo };
  }

  // Caso cursore singolo (nessuna selezione): agisce sulla parola sotto il cursore se presente
  if (selFrom === selTo) {
    const line = lines.find((l) => selFrom >= l.from && selFrom <= l.to);
    if (!line) return { text: docText, from: selFrom, to: selTo };

    const parsed = parseInlineLine(line.text, line.from);
    if (parsed.isHr || parsed.cells.length === 0) {
      return { text: docText, from: selFrom, to: selTo };
    }

    const containingLinkAtCursor = parsed.links.find(
      (lnk) =>
        lnk.type === 'mdlink' &&
        !/^(https?:\/\/|www\.|mailto:)/i.test(lnk.rawLabel) &&
        (style === 'code' || !lnk[style]) &&
        selFrom >= lnk.labelFrom &&
        selFrom <= lnk.labelTo,
    );
    if (containingLinkAtCursor) {
      const innerRes = toggleInlineStyleOnDoc(
        containingLinkAtCursor.rawLabel,
        selFrom - containingLinkAtCursor.labelFrom,
        selFrom - containingLinkAtCursor.labelFrom,
        style,
      );
      if (innerRes.text !== containingLinkAtCursor.rawLabel) {
        const nextDoc =
          docText.slice(0, containingLinkAtCursor.labelFrom) +
          innerRes.text +
          docText.slice(containingLinkAtCursor.labelTo);
        const newCursor = containingLinkAtCursor.labelFrom + innerRes.from;
        return { text: nextDoc, from: newCursor, to: newCursor };
      }
    }

    const isWordCell = (c: CharCell) => !c.atomic && /[\p{L}\p{N}_]/u.test(c.ch);
    let hitIdx = parsed.cells.findIndex(
      (c) => isWordCell(c) && selFrom >= c.origFrom && selFrom <= c.origTo,
    );
    if (hitIdx === -1) {
      return { text: docText, from: selFrom, to: selTo };
    }

    let wStart = hitIdx;
    while (wStart > 0 && isWordCell(parsed.cells[wStart - 1]!)) {
      wStart--;
    }
    let wEnd = hitIdx;
    while (wEnd + 1 < parsed.cells.length && isWordCell(parsed.cells[wEnd + 1]!)) {
      wEnd++;
    }

    const wordCells = parsed.cells.slice(wStart, wEnd + 1);
    const shouldEnable = !wordCells.every((c) => c[style]);
    for (let i = wStart; i <= wEnd; i++) {
      parsed.cells[i]![style] = shouldEnable;
    }

    // Trova la posizione relativa del cursore rispetto alle celle della parola
    let cursorCellIdx = wStart;
    let atEndOfCell = false;
    for (let i = wStart; i <= wEnd; i++) {
      const c = parsed.cells[i]!;
      if (selFrom <= c.origFrom) {
        cursorCellIdx = i;
        atEndOfCell = false;
        break;
      }
      if (selFrom <= c.origTo) {
        cursorCellIdx = i;
        atEndOfCell = true;
        break;
      }
    }

    const { text: serializedInline, offsets } = serializeCells(parsed.cells);
    const newLineText = line.text.slice(0, parsed.prefixLen) + serializedInline;
    const newLines = lines.map((l) => (l.index === line.index ? newLineText : l.text));
    const cellOffset = offsets[cursorCellIdx]!;
    const newCursor =
      line.from + parsed.prefixLen + (atEndOfCell ? cellOffset.to : cellOffset.from);

    return {
      text: newLines.join('\n'),
      from: newCursor,
      to: newCursor,
    };
  }

  // Caso selezione non vuota (una o più righe)
  const startLineIdx = lines.findIndex((l) => selFrom >= l.from && selFrom <= l.to);
  const endLineIdx = lines.findIndex((l) => selTo >= l.from && selTo <= l.to);
  if (startLineIdx === -1 || endLineIdx === -1) {
    return { text: docText, from: selFrom, to: selTo };
  }

  // Se la selezione cade interamente dentro l'etichetta di un link Markdown [testo](url),
  // applica la formattazione direttamente sul testo interno preservando il link
  if (startLineIdx === endLineIdx) {
    const singleLine = lines[startLineIdx]!;
    const singleParsed = parseInlineLine(singleLine.text, singleLine.from);
    const containingLink = singleParsed.links.find(
      (lnk) =>
        lnk.type === 'mdlink' &&
        !/^(https?:\/\/|www\.|mailto:)/i.test(lnk.rawLabel) &&
        (style === 'code' || !lnk[style]) &&
        selFrom >= lnk.labelFrom &&
        selTo <= lnk.labelTo,
    );
    if (containingLink) {
      const innerRes = toggleInlineStyleOnDoc(
        containingLink.rawLabel,
        selFrom - containingLink.labelFrom,
        selTo - containingLink.labelFrom,
        style,
      );
      const nextDoc =
        docText.slice(0, containingLink.labelFrom) +
        innerRes.text +
        docText.slice(containingLink.labelTo);
      return {
        text: nextDoc,
        from: containingLink.labelFrom + innerRes.from,
        to: containingLink.labelFrom + innerRes.to,
      };
    }
  }

  const parsedByLine = new Map<
    number,
    { parsed: ParsedInlineLine; selectedIndices: number[]; nonWsIndices: number[] }
  >();
  const allNonWsSelected: CharCell[] = [];

  for (let idx = startLineIdx; idx <= endLineIdx; idx++) {
    const line = lines[idx]!;
    const parsed = parseInlineLine(line.text, line.from);
    if (parsed.isHr) continue;

    const lineSelFrom = idx === startLineIdx ? selFrom : line.from + parsed.prefixLen;
    const lineSelTo = idx === endLineIdx ? selTo : line.to;

    const selectedIndices: number[] = [];
    const nonWsIndices: number[] = [];

    for (let cIdx = 0; cIdx < parsed.cells.length; cIdx++) {
      const cell = parsed.cells[cIdx]!;
      if (cell.origTo > lineSelFrom && cell.origFrom < lineSelTo) {
        selectedIndices.push(cIdx);
        if (!/^\s+$/.test(cell.ch) && !(style === 'code' && cell.atomic)) {
          nonWsIndices.push(cIdx);
          allNonWsSelected.push(cell);
        }
      }
    }

    parsedByLine.set(idx, { parsed, selectedIndices, nonWsIndices });
  }

  if (allNonWsSelected.length === 0) {
    return { text: docText, from: selFrom, to: selTo };
  }

  const shouldEnable = !allNonWsSelected.every((c) => c[style]);

  const updatedLineTexts = lines.map((l) => l.text);
  let firstSelectionAnchor: { lineIdx: number; relOffset: number } | null = null;
  let lastSelectionHead: { lineIdx: number; relOffset: number } | null = null;

  for (let idx = startLineIdx; idx <= endLineIdx; idx++) {
    const entry = parsedByLine.get(idx);
    if (!entry || entry.nonWsIndices.length === 0) continue;

    const { parsed, selectedIndices, nonWsIndices } = entry;
    const firstNonWs = nonWsIndices[0]!;
    const lastNonWs = nonWsIndices[nonWsIndices.length - 1]!;

    if (shouldEnable) {
      for (let cIdx = firstNonWs; cIdx <= lastNonWs; cIdx++) {
        const cell = parsed.cells[cIdx]!;
        if (style === 'code' && cell.atomic) continue;
        cell[style] = true;
      }
    } else {
      for (const cIdx of selectedIndices) {
        parsed.cells[cIdx]![style] = false;
      }
    }

    const { text: serializedInline, offsets } = serializeCells(parsed.cells);
    updatedLineTexts[idx] = lines[idx]!.text.slice(0, parsed.prefixLen) + serializedInline;

    if (!firstSelectionAnchor) {
      firstSelectionAnchor = {
        lineIdx: idx,
        relOffset: parsed.prefixLen + offsets[firstNonWs]!.from,
      };
    }
    lastSelectionHead = {
      lineIdx: idx,
      relOffset: parsed.prefixLen + offsets[lastNonWs]!.to,
    };
  }

  const newDocText = updatedLineTexts.join('\n');
  const newLines = splitDocLines(newDocText);

  let newFrom = firstSelectionAnchor
    ? newLines[firstSelectionAnchor.lineIdx]!.from + firstSelectionAnchor.relOffset
    : selFrom;
  let newTo = lastSelectionHead
    ? newLines[lastSelectionHead.lineIdx]!.from + lastSelectionHead.relOffset
    : selTo;

  // Se la selezione risultante corrisponde esattamente a un singolo link esterno,
  // posiziona la selezione sulla sola porzione visibile del link (non sui caratteri nascosti)
  if (startLineIdx === endLineIdx) {
    const newSingleLine = newLines[startLineIdx]!;
    const reparsed = parseInlineLine(newSingleLine.text, newSingleLine.from);
    const matchedLink = reparsed.links.find((l) => l.from === newFrom && l.to === newTo);
    if (matchedLink && matchedLink.visibleTo > matchedLink.visibleFrom) {
      newFrom = matchedLink.visibleFrom;
      newTo = matchedLink.visibleTo;
    }
  }

  return {
    text: newDocText,
    from: newFrom,
    to: newTo,
  };
}

/**
 * Attiva o disattiva il formato [[Wikilink]] in modo idempotente a parità di selezione.
 */
export function toggleWikilinkOnDoc(
  docText: string,
  selFrom: number,
  selTo: number,
): { text: string; from: number; to: number } {
  if (selFrom === selTo) {
    return { text: docText, from: selFrom, to: selTo };
  }

  const selected = docText.slice(selFrom, selTo);

  // Caso 1: la selezione include già [[...]]
  if (selected.startsWith('[[') && selected.endsWith(']]') && selected.length > 4) {
    const inner = selected.slice(2, -2);
    const next = docText.slice(0, selFrom) + inner + docText.slice(selTo);
    return { text: next, from: selFrom, to: selFrom + inner.length };
  }

  // Caso 2: la selezione è esattamente all'interno di [[...]]
  if (
    selFrom >= 2 &&
    selTo + 2 <= docText.length &&
    docText.slice(selFrom - 2, selFrom) === '[[' &&
    docText.slice(selTo, selTo + 2) === ']]'
  ) {
    const next = docText.slice(0, selFrom - 2) + selected + docText.slice(selTo + 2);
    return { text: next, from: selFrom - 2, to: selFrom - 2 + selected.length };
  }

  // Caso 3: applica [[...]] mantenendo selezionato l'intero wikilink per il toggle inverso
  const trimmed = selected.trim();
  if (!trimmed) {
    return { text: docText, from: selFrom, to: selTo };
  }
  const leadLen = selected.length - selected.trimStart().length;
  const trailLen = selected.length - selected.trimEnd().length;
  const targetFrom = selFrom + leadLen;
  const targetTo = selTo - trailLen;
  const wrapped = `[[${trimmed}]]`;
  const next = docText.slice(0, targetFrom) + wrapped + docText.slice(targetTo);
  return { text: next, from: targetFrom, to: targetFrom + wrapped.length };
}

/**
 * Restituisce quali stili sono attualmente attivi sull'intera selezione corrente.
 */
export function getActiveInlineStyles(
  docText: string,
  selFrom: number,
  selTo: number,
): {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  wikilink: boolean;
  externalLink: ParsedLink | null;
} {
  if (selFrom >= selTo) {
    return {
      bold: false,
      italic: false,
      strike: false,
      code: false,
      wikilink: false,
      externalLink: null,
    };
  }

  const selected = docText.slice(selFrom, selTo);
  const wikilink =
    (selected.startsWith('[[') && selected.endsWith(']]') && selected.length > 4) ||
    (selFrom >= 2 &&
      selTo + 2 <= docText.length &&
      docText.slice(selFrom - 2, selFrom) === '[[' &&
      docText.slice(selTo, selTo + 2) === ']]');

  const lines = splitDocLines(docText);
  const startLineIdx = lines.findIndex((l) => selFrom >= l.from && selFrom <= l.to);
  const endLineIdx = lines.findIndex((l) => selTo >= l.from && selTo <= l.to);
  if (startLineIdx === -1 || endLineIdx === -1) {
    return {
      bold: false,
      italic: false,
      strike: false,
      code: false,
      wikilink,
      externalLink: null,
    };
  }

  let externalLink: ParsedLink | null = null;
  if (startLineIdx === endLineIdx) {
    const singleLine = lines[startLineIdx]!;
    const singleParsed = parseInlineLine(singleLine.text, singleLine.from);
    externalLink =
      singleParsed.links.find(
        (lnk) => lnk.isExternal && lnk.to > selFrom && lnk.from < selTo,
      ) ?? null;

    const containingMdLink = singleParsed.links.find(
      (lnk) =>
        lnk.type === 'mdlink' &&
        !/^(https?:\/\/|www\.|mailto:)/i.test(lnk.rawLabel) &&
        selFrom >= lnk.labelFrom &&
        selTo <= lnk.labelTo,
    );
    if (containingMdLink) {
      const innerActive = getActiveInlineStyles(
        containingMdLink.rawLabel,
        selFrom - containingMdLink.labelFrom,
        selTo - containingMdLink.labelFrom,
      );
      return {
        bold: containingMdLink.bold || innerActive.bold,
        italic: containingMdLink.italic || innerActive.italic,
        strike: containingMdLink.strike || innerActive.strike,
        code: innerActive.code,
        wikilink,
        externalLink: containingMdLink.isExternal ? containingMdLink : null,
      };
    }
  }

  const nonWsCells: CharCell[] = [];
  for (let idx = startLineIdx; idx <= endLineIdx; idx++) {
    const line = lines[idx]!;
    const parsed = parseInlineLine(line.text, line.from);
    if (parsed.isHr) continue;
    const lineSelFrom = idx === startLineIdx ? selFrom : line.from + parsed.prefixLen;
    const lineSelTo = idx === endLineIdx ? selTo : line.to;
    for (const cell of parsed.cells) {
      if (cell.origTo > lineSelFrom && cell.origFrom < lineSelTo && !/^\s+$/.test(cell.ch)) {
        nonWsCells.push(cell);
      }
    }
  }

  if (nonWsCells.length === 0) {
    return {
      bold: false,
      italic: false,
      strike: false,
      code: false,
      wikilink,
      externalLink,
    };
  }

  return {
    bold: nonWsCells.every((c) => c.bold),
    italic: nonWsCells.every((c) => c.italic),
    strike: nonWsCells.every((c) => c.strike),
    code:
      nonWsCells.filter((c) => !c.atomic).length > 0 &&
      nonWsCells.filter((c) => !c.atomic).every((c) => c.code),
    wikilink,
    externalLink,
  };
}

/**
 * Se l'utente incolla un URL esterno sopra del testo già selezionato nella nota,
 * trasforma la selezione in [testo](url) mantenendo invariato il testo visibile.
 * Restituisce `null` se l'incolla deve procedere normalmente (es. nessuna selezione o testo non URL).
 */
export function pasteExternalUrlOnDoc(
  docText: string,
  selFrom: number,
  selTo: number,
  rawClipboardText: string,
): { text: string; cursor: number } | null {
  if (selFrom >= selTo) return null;

  const trimmedClip = rawClipboardText.trim();
  if (
    !/^(https?:\/\/|mailto:)[^\s<>]+$/i.test(trimmedClip) &&
    !/^www\.[^\s<>]+\.[^\s<>]+$/i.test(trimmedClip)
  ) {
    return null;
  }
  const url = normalizeExternalUrl(trimmedClip);

  const selected = docText.slice(selFrom, selTo);
  if (selected.includes('\n')) return null;

  const trimmed = selected.trim();
  if (!trimmed) return null;

  // Se il testo selezionato è già un URL nudo, lascialo sostituire normalmente
  if (/^(https?:\/\/|mailto:|www\.)[^\s]+$/i.test(trimmed)) {
    return null;
  }

  // Verifica se la selezione cade dentro un link esistente sulla stessa riga
  const lines = splitDocLines(docText);
  const line = lines.find((l) => selFrom >= l.from && selTo <= l.to);
  if (line) {
    const parsed = parseInlineLine(line.text, line.from);
    const existingLink = parsed.links.find(
      (lnk) => lnk.type === 'mdlink' && selFrom >= lnk.from && selTo <= lnk.to,
    );
    if (existingLink) {
      return updateExistingLinkOnDoc(
        docText,
        existingLink.from,
        existingLink.to,
        existingLink.rawLabel,
        url,
        existingLink.standalone,
      );
    }
  }

  const lead = selected.length - selected.trimStart().length;
  const trail = selected.length - selected.trimEnd().length;
  const targetFrom = selFrom + lead;
  const targetTo = selTo - trail;

  const existingMdLink = trimmed.match(/^\[([^\]\n]+)\]\(([^)\n]+)\)$/);
  const cleanLabel = existingMdLink ? existingMdLink[1]!.trim() : trimmed;

  const replacement = `[${cleanLabel}](${url})`;
  const nextDoc = docText.slice(0, targetFrom) + replacement + docText.slice(targetTo);

  return {
    text: nextDoc,
    cursor: targetFrom + replacement.length,
  };
}

/**
 * Applica o aggiorna (o rimuove se url vuoto) un link esterno sulla selezione corrente
 * (usato dallo strumento Link nella barra di selezione testo).
 */
export function applyExternalLinkOnDoc(
  docText: string,
  selFrom: number,
  selTo: number,
  rawUrl: string,
): { text: string; from: number; to: number } {
  const url = normalizeExternalUrl(rawUrl);
  const lines = splitDocLines(docText);
  const line = lines.find((l) => selFrom >= l.from && selTo <= l.to);

  if (line) {
    const parsed = parseInlineLine(line.text, line.from);
    const existing = parsed.links.find(
      (lnk) => lnk.isExternal && lnk.to > selFrom && lnk.from < selTo,
    );
    if (existing) {
      if (!url) {
        // Rimuove il link lasciando solo il testo
        const plainLabel = existing.rawLabel || existing.label;
        const nextDoc = docText.slice(0, existing.from) + plainLabel + docText.slice(existing.to);
        return {
          text: nextDoc,
          from: existing.from,
          to: existing.from + plainLabel.length,
        };
      }
      const updated = updateExistingLinkOnDoc(
        docText,
        existing.from,
        existing.to,
        existing.rawLabel || existing.label,
        url,
        existing.standalone && existing.type !== 'mdlink' ? false : existing.standalone,
      );
      return {
        text: updated.text,
        from: existing.from + 1,
        to: existing.from + 1 + (existing.rawLabel || existing.label).length,
      };
    }
  }

  if (!url || selFrom >= selTo) {
    return { text: docText, from: selFrom, to: selTo };
  }

  const pasted = pasteExternalUrlOnDoc(docText, selFrom, selTo, url);
  if (!pasted) {
    return { text: docText, from: selFrom, to: selTo };
  }

  const selected = docText.slice(selFrom, selTo);
  const lead = selected.length - selected.trimStart().length;
  const cleanLen = selected.trim().length;
  const labelStart = selFrom + lead + 1;
  return {
    text: pasted.text,
    from: labelStart,
    to: labelStart + cleanLen,
  };
}

/**
 * Modifica sia il titolo sia l'URL di un link esistente (sia link preview sia link normale).
 */
export function updateExistingLinkOnDoc(
  docText: string,
  linkFrom: number,
  linkTo: number,
  newTitle: string,
  newUrl: string,
  standalone: boolean,
): { text: string; cursor: number } {
  const cleanUrl = normalizeExternalUrl(newUrl);
  const safeTitle = newTitle.replace(/[\[\]\r\n]/g, '').trim() || formatStandaloneUrlLabel(cleanUrl);
  if (!cleanUrl) {
    const nextDoc = docText.slice(0, linkFrom) + safeTitle + docText.slice(linkTo);
    return { text: nextDoc, cursor: linkFrom + safeTitle.length };
  }

  const replacement = standalone
    ? `[${safeTitle}](${cleanUrl} "preview")`
    : `[${safeTitle}](${cleanUrl})`;
  const nextDoc = docText.slice(0, linkFrom) + replacement + docText.slice(linkTo);
  return {
    text: nextDoc,
    cursor: linkFrom + replacement.length,
  };
}

/**
 * Estrae il titolo modificabile di un link senza mostrare delimitatori Markdown (**, *, ~~, `),
 * restituendo anche eventuali delimitatori esterni simmetrici per preservarli al salvataggio.
 */
export function extractEditableLinkTitle(lnk: ParsedLink): {
  cleanTitle: string;
  wrapPrefix: string;
  wrapSuffix: string;
} {
  if (lnk.type !== 'mdlink') {
    return { cleanTitle: lnk.label, wrapPrefix: '', wrapSuffix: '' };
  }

  let inner = lnk.rawLabel;
  let wrapPrefix = '';
  let wrapSuffix = '';
  const markers = ['***', '**', '*', '~~', '`'];
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of markers) {
      if (inner.startsWith(m) && inner.endsWith(m) && inner.length > m.length * 2) {
        wrapPrefix += m;
        wrapSuffix = m + wrapSuffix;
        inner = inner.slice(m.length, inner.length - m.length);
        changed = true;
        break;
      }
    }
  }

  if (lnk.standalone && /^(https?:\/\/|www\.|mailto:)/i.test(inner)) {
    return { cleanTitle: formatStandaloneUrlLabel(inner), wrapPrefix, wrapSuffix };
  }

  return { cleanTitle: inner, wrapPrefix, wrapSuffix };
}

/**
 * Trova il link esterno che contiene o tocca una data posizione nel documento.
 */
export function findExternalLinkAtPos(docText: string, pos: number): ParsedLink | null {
  const lines = splitDocLines(docText);
  const line = lines.find((l) => pos >= l.from && pos <= l.to);
  if (!line) return null;
  const parsed = parseInlineLine(line.text, line.from);
  return (
    parsed.links.find((lnk) => lnk.isExternal && pos >= lnk.from && pos <= lnk.to) ?? null
  );
}
