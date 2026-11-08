import type { PageIdentity, TreeEntry } from '@brain/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  autocompletion,
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  StateEffect,
  StateField,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import {
  Check,
  ChevronRight,
  Code,
  ExternalLink,
  Link,
  Pencil,
  Trash2,
} from 'lucide-react';
import { api } from '../api/client.js';
import { parseFrontmatter } from '../core/frontmatter.js';
import {
  applyExternalLinkOnDoc,
  BLOCK_PREFIX_RE,
  extractEditableLinkTitle,
  findExternalLinkAtPos,
  formatStandaloneUrlLabel,
  getActiveInlineStyles,
  normalizeExternalUrl,
  parseInlineLine,
  pasteExternalUrlOnDoc,
  toggleInlineStyleOnDoc,
  updateExistingLinkOnDoc,
  type CharCell,
  type InlineStyle,
  type ParsedLink,
} from '../core/inlineFormat.js';
import {
  getNoteDisplayName,
  isHomePage,
  nodeDirOfPagePath,
  purgeMissingInternalLinksFromMarkdown,
  resolveInternalPageTarget,
  sanitizeNoteTitleForFilename,
  type ResolvedPageTarget,
} from '../core/pages.js';
import {
  extractVistaBlocks,
  replaceVistaBlockInMarkdown,
  serializeVistaBlock,
  type ExtractedVistaBlock,
} from '../core/table-ui.js';
import { TableViewWidget } from './TableViewWidget.js';

export interface EditorProps {
  value: string;
  onChange: (val: string) => void;
  theme: 'light' | 'dark';
  availableNotes: string[];
  entries?: TreeEntry[];
  pages?: PageIdentity[];
  liveTitleDrafts?: Record<string, string>;
  onLiveTitleDraftChange?: (draft: string | null) => void;
  onSaveShortcut?: () => void;
  onOpenWikilink?: (targetPath: string) => void;
  onRenameTitle?: (newName: string, options?: { fromPath?: string; live?: boolean }) => void;
  onCreateSubpage?: (
    replaceSlashWithToken: (token: string) => string,
    initialTitle?: string,
  ) => Promise<{ pageId?: string; path: string } | undefined>;
  onPatchFrontmatter?: (key: string, value: unknown, unset?: boolean) => void;
  onTreeMutated?: (convertedHost?: { from: string; to: string }) => Promise<void> | void;
  topPanel?: React.ReactNode;
  bottomPanel?: React.ReactNode;
  autoFocusTitle?: boolean;
  onTitleAutoFocused?: () => void;
  path?: string;
}

// ---------------------------------------------------------------------------
// Widget per la visualizzazione diretta senza vedere la sintassi raw
// ---------------------------------------------------------------------------

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly lineFrom: number,
  ) {
    super();
  }

  override eq(other: CheckboxWidget) {
    return this.checked === other.checked && this.lineFrom === other.lineFrom;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-notion-check-wrap';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'cm-notion-check-input';
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('change', (e) => {
      e.stopPropagation();
      const line = view.state.doc.lineAt(this.lineFrom);
      const match = line.text.match(/^(\s*-\s+)\[([ xX])\]/);
      if (match) {
        const next = this.checked ? '[ ]' : '[x]';
        const start = line.from + match[1]!.length;
        view.dispatch({
          changes: { from: start, to: start + 3, insert: next },
        });
      }
    });
    wrap.appendChild(input);
    return wrap;
  }

  override ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-notion-bullet';
    span.textContent = '•';
    return span;
  }
}

class HrWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const hr = document.createElement('hr');
    hr.className = 'cm-notion-hr-widget';
    return hr;
  }
}

// ---------------------------------------------------------------------------
// Widget per i Link: Pagine Interne (wikilink e link interni) vs Icona Favicon
// ---------------------------------------------------------------------------

const openWikilinkFacet = Facet.define<(target: string) => void, (target: string) => void>({
  combine: (values) => values[0] || (() => {}),
});

const resolvePageFacet = Facet.define<
  (rawTarget: string) => ResolvedPageTarget | null,
  (rawTarget: string) => ResolvedPageTarget | null
>({
  combine: (values) => values[0] || (() => null),
});

const refreshDecorationsEffect = StateEffect.define<null>();

class InternalLinkWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string,
    readonly icona: string | null,
    readonly onOpen: (target: string) => void,
  ) {
    super();
  }

  override eq(other: InternalLinkWidget) {
    return (
      this.target === other.target &&
      this.label === other.label &&
      this.icona === other.icona
    );
  }

  override toDOM(): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'cm-notion-link cm-notion-link-internal';
    chip.title = `Pagina interna: ${this.label} (clicca per aprire)`;

    const icon = document.createElement('span');
    icon.className = 'cm-link-icon';
    if (this.icona) {
      icon.textContent = this.icona;
      icon.style.fontSize = '12px';
    } else {
      icon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`;
    }

    const text = document.createElement('span');
    text.className = 'cm-link-text';
    text.textContent = this.label;

    chip.appendChild(icon);
    chip.appendChild(text);

    chip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onOpen(this.target);
    });

    return chip;
  }

  override ignoreEvent() {
    return false;
  }
}

const GENERIC_GLOBE_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

const faviconStatusCache = new Map<string, 'ok' | 'fail'>();
const customFaviconByUrl = new Map<string, string>();
const customFaviconByOrigin = new Map<string, string>();
const metaFaviconChecked = new Set<string>();

function getDefaultFaviconUrl(rawUrl: string): string | null {
  if (customFaviconByUrl.has(rawUrl)) {
    return customFaviconByUrl.get(rawUrl)!;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (customFaviconByOrigin.has(parsed.origin)) {
      return customFaviconByOrigin.get(parsed.origin)!;
    }
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

class FaviconIconWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly linkFrom: number,
    readonly linkTo: number,
  ) {
    super();
  }

  override eq(other: FaviconIconWidget) {
    return (
      this.url === other.url &&
      this.linkFrom === other.linkFrom &&
      this.linkTo === other.linkTo
    );
  }

  override toDOM(): HTMLElement {
    const iconWrap = document.createElement('span');
    iconWrap.className = 'cm-link-favicon-wrap';
    iconWrap.dataset.externalUrl = this.url;
    iconWrap.dataset.linkFrom = String(this.linkFrom);
    iconWrap.dataset.linkTo = String(this.linkTo);
    iconWrap.innerHTML = GENERIC_GLOBE_SVG;

    const mountImg = (srcUrl: string, onFail?: () => void) => {
      const img = document.createElement('img');
      img.className = 'cm-link-favicon-img';
      img.src = srcUrl;
      img.alt = '';
      img.addEventListener('error', () => {
        faviconStatusCache.set(srcUrl, 'fail');
        iconWrap.innerHTML = GENERIC_GLOBE_SVG;
        onFail?.();
      });
      iconWrap.innerHTML = '';
      iconWrap.appendChild(img);
    };

    const tryProbe = (candidateUrl: string, allowMetaFallback: boolean) => {
      const cached = faviconStatusCache.get(candidateUrl);
      if (cached === 'ok') {
        mountImg(candidateUrl);
        return;
      }
      if (cached === 'fail') {
        if (allowMetaFallback) this.tryResolveCustomFavicon(iconWrap, mountImg);
        return;
      }

      const probe = new Image();
      probe.onload = () => {
        if (probe.naturalWidth > 0) {
          faviconStatusCache.set(candidateUrl, 'ok');
          mountImg(candidateUrl);
        } else {
          faviconStatusCache.set(candidateUrl, 'fail');
          if (allowMetaFallback) this.tryResolveCustomFavicon(iconWrap, mountImg);
        }
      };
      probe.onerror = () => {
        faviconStatusCache.set(candidateUrl, 'fail');
        if (allowMetaFallback) this.tryResolveCustomFavicon(iconWrap, mountImg);
      };
      probe.src = candidateUrl;
    };

    const faviconUrl = getDefaultFaviconUrl(this.url);
    if (faviconUrl) {
      tryProbe(faviconUrl, true);
    }

    return iconWrap;
  }

  private tryResolveCustomFavicon(
    iconWrap: HTMLElement,
    mountImg: (src: string) => void,
  ) {
    if (metaFaviconChecked.has(this.url)) return;
    metaFaviconChecked.add(this.url);
    void api.getLinkMeta(this.url).then((meta) => {
      if (!meta.favicon) return;
      customFaviconByUrl.set(this.url, meta.favicon);
      try {
        customFaviconByOrigin.set(new URL(this.url).origin, meta.favicon);
      } catch {
        // ignore invalid URL
      }
      if (!iconWrap.isConnected) return;
      const probe = new Image();
      probe.onload = () => {
        if (probe.naturalWidth > 0 && iconWrap.isConnected) {
          faviconStatusCache.set(meta.favicon!, 'ok');
          mountImg(meta.favicon!);
        }
      };
      probe.src = meta.favicon;
    });
  }
}

// Etichetta del linguaggio mostrata al posto della riga di apertura ``` di un blocco codice
class CodeLangWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }

  override eq(other: CodeLangWidget) {
    return this.lang === other.lang;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-notion-code-lang';
    span.textContent = this.lang || 'Codice';
    return span;
  }
}

export interface VistaPortalCallbacks {
  onMount: (index: number, el: HTMLElement, block: ExtractedVistaBlock) => void;
  onUnmount: (index: number, el: HTMLElement) => void;
}

const vistaPortalFacet = Facet.define<VistaPortalCallbacks, VistaPortalCallbacks>({
  combine: (vals) =>
    vals[0] ?? {
      onMount: () => {},
      onUnmount: () => {},
    },
});

class VistaPortalWidget extends WidgetType {
  constructor(
    readonly block: ExtractedVistaBlock,
    readonly callbacks: VistaPortalCallbacks,
  ) {
    super();
  }

  override eq(other: VistaPortalWidget): boolean {
    return (
      this.block.index === other.block.index &&
      this.block.rawBlock === other.block.rawBlock &&
      this.block.fromOffset === other.block.fromOffset
    );
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-vista-widget-mount';
    wrap.dataset.vistaIndex = String(this.block.index);
    this.callbacks.onMount(this.block.index, wrap, this.block);
    return wrap;
  }

  override destroy(dom: HTMLElement): void {
    this.callbacks.onUnmount(this.block.index, dom);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function isSelectionInsideVistaBlock(state: EditorState, block: ExtractedVistaBlock): boolean {
  if (block.kind !== 'vista') return false;
  return state.selection.ranges.some(
    (sel) => sel.from > block.fromOffset && sel.to < block.toOffset,
  );
}

function buildVistaBlockDecorations(state: EditorState): DecorationSet {
  const docStr = state.doc.toString();
  const blocks = extractVistaBlocks(docStr);
  if (blocks.length === 0) return Decoration.none;
  const callbacks = state.facet(vistaPortalFacet);
  const ranges: Range<Decoration>[] = [];

  for (const blk of blocks) {
    if (blk.toOffset <= blk.fromOffset) continue;
    if (isSelectionInsideVistaBlock(state, blk)) {
      continue;
    }
    ranges.push(
      Decoration.replace({
        widget: new VistaPortalWidget(blk, callbacks),
        block: true,
      }).range(blk.fromOffset, blk.toOffset),
    );
  }
  return Decoration.set(ranges, true);
}

const vistaBlockStateField = StateField.define<DecorationSet>({
  create(state) {
    return buildVistaBlockDecorations(state);
  },
  update(decos, tr) {
    const forced = tr.effects.some((e) => e.is(refreshDecorationsEffect));
    if (tr.docChanged || tr.selection || forced) {
      return buildVistaBlockDecorations(tr.state);
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Raccoglie le righe che appartengono a blocchi di codice (``` ... ```)
function collectCodeBlockLines(view: EditorView): Map<number, { first: boolean; last: boolean }> {
  const result = new Map<number, { first: boolean; last: boolean }>();
  const doc = view.state.doc;
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
          const startLine = doc.lineAt(node.from).number;
          const endLine = doc.lineAt(node.to).number;
          for (let n = startLine; n <= endLine; n++) {
            result.set(n, { first: n === startLine, last: n === endLine });
          }
          return false;
        }
        return undefined;
      },
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Costruzione decorazioni Live WYSIWYG ordinata tramite Decoration.set(..., true)
// ---------------------------------------------------------------------------

const h1LineDeco = Decoration.line({ class: 'cm-notion-h1' });
const h2LineDeco = Decoration.line({ class: 'cm-notion-h2' });
const h3LineDeco = Decoration.line({ class: 'cm-notion-h3' });
const quoteLineDeco = Decoration.line({ class: 'cm-notion-quote' });
const taskLineDeco = Decoration.line({ class: 'cm-notion-task' });
const taskCheckedLineDeco = Decoration.line({ class: 'cm-notion-task cm-notion-task-checked' });
const hiddenSyntax = Decoration.replace({});

const boldDeco = Decoration.mark({ class: 'cm-notion-bold' });
const italicDeco = Decoration.mark({ class: 'cm-notion-italic' });
const strikethroughDeco = Decoration.mark({ class: 'cm-notion-strikethrough' });
const inlineCodeDeco = Decoration.mark({ class: 'cm-notion-inline-code' });

function emitStyleRuns(
  cells: CharCell[],
  prop: InlineStyle,
  deco: Decoration,
  ranges: Range<Decoration>[],
) {
  let runFrom = -1;
  let runTo = -1;
  for (const cell of cells) {
    if (!cell.atomic && cell[prop]) {
      if (runFrom !== -1 && cell.origFrom === runTo) {
        runTo = cell.origTo;
      } else {
        if (runFrom !== -1 && runTo > runFrom) {
          ranges.push(deco.range(runFrom, runTo));
        }
        runFrom = cell.origFrom;
        runTo = cell.origTo;
      }
    } else if (runFrom !== -1) {
      if (runTo > runFrom) {
        ranges.push(deco.range(runFrom, runTo));
      }
      runFrom = -1;
      runTo = -1;
    }
  }
  if (runFrom !== -1 && runTo > runFrom) {
    ranges.push(deco.range(runFrom, runTo));
  }
}

function buildNotionDecorations(view: EditorView): {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
} {
  const ranges: Range<Decoration>[] = [];
  const atomicList: Range<Decoration>[] = [];
  const openLink = view.state.facet(openWikilinkFacet);
  const resolvePage = view.state.facet(resolvePageFacet);
  const codeLines = collectCodeBlockLines(view);
  const vistaBlocks = extractVistaBlocks(view.state.doc.toString());
  const replacedVistaLines = new Set<number>();
  const rawEditingVistaLines = new Set<number>();
  for (const vb of vistaBlocks) {
    const isEditingYaml = isSelectionInsideVistaBlock(view.state, vb);
    for (let ln = vb.startLine; ln <= vb.endLine; ln++) {
      if (isEditingYaml) {
        rawEditingVistaLines.add(ln);
      } else {
        replacedVistaLines.add(ln);
      }
    }
  }

  const pushAtomicReplace = (deco: Decoration, from: number, to: number) => {
    if (to <= from) return;
    const r = deco.range(from, to);
    ranges.push(r);
    atomicList.push(r);
  };

  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;

      // Righe coperte da una vista a tabella attiva: non aggiungere decorazioni di riga
      if (replacedVistaLines.has(line.number)) {
        pos = line.to + 1;
        continue;
      }

      // Righe di un blocco ```vista attualmente in modifica YAML: mostra il testo grezzo inclusi i ```
      if (rawEditingVistaLines.has(line.number)) {
        ranges.push(Decoration.line({ class: 'cm-notion-codeblock' }).range(line.from));
        pos = line.to + 1;
        continue;
      }

      // Blocco di codice: riquadro grafico, recinzioni ``` sempre nascoste
      const codeInfo = codeLines.get(line.number);
      if (codeInfo) {
        const classes = ['cm-notion-codeblock'];
        if (codeInfo.first) classes.push('cm-notion-codeblock-first');
        if (codeInfo.last) classes.push('cm-notion-codeblock-last');
        ranges.push(Decoration.line({ class: classes.join(' ') }).range(line.from));

        const openFence = codeInfo.first ? text.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)?.*$/) : null;
        const closeFence =
          !codeInfo.first && codeInfo.last ? /^\s*(`{3,}|~{3,})\s*$/.test(text) : false;
        if (openFence && line.to > line.from) {
          pushAtomicReplace(
            Decoration.replace({ widget: new CodeLangWidget(openFence[2] || '') }),
            line.from,
            line.to,
          );
        } else if (closeFence && line.to > line.from) {
          pushAtomicReplace(hiddenSyntax, line.from, line.to);
        }
        pos = line.to + 1;
        continue;
      }

      // 1. Separatore orizzontale (---) - sempre visualizzato graficamente
      if (/^\s*---+\s*$/.test(text)) {
        pushAtomicReplace(Decoration.replace({ widget: new HrWidget() }), line.from, line.to);
        pos = line.to + 1;
        continue;
      }

      // 2. Titoli H1, H2, H3..H6 (nasconde sempre i caratteri #)
      if (/^#\s+/.test(text)) {
        const m = text.match(/^#\s+/)!;
        ranges.push(h1LineDeco.range(line.from));
        pushAtomicReplace(hiddenSyntax, line.from, line.from + m[0].length);
      } else if (/^##\s+/.test(text)) {
        const m = text.match(/^##\s+/)!;
        ranges.push(h2LineDeco.range(line.from));
        pushAtomicReplace(hiddenSyntax, line.from, line.from + m[0].length);
      } else if (/^#{3,6}\s+/.test(text)) {
        const m = text.match(/^#{3,6}\s+/)!;
        ranges.push(h3LineDeco.range(line.from));
        pushAtomicReplace(hiddenSyntax, line.from, line.from + m[0].length);
      }
      // 3. Attività con casella (- [ ] o - [x])
      else if (/^\s*-\s+\[([ xX])\]\s*/.test(text)) {
        const match = text.match(/^(\s*-\s+)\[([ xX])\]\s*/)!;
        const isChecked = match[2]!.toLowerCase() === 'x';
        ranges.push((isChecked ? taskCheckedLineDeco : taskLineDeco).range(line.from));
        pushAtomicReplace(
          Decoration.replace({ widget: new CheckboxWidget(isChecked, line.from) }),
          line.from,
          line.from + match[0].length,
        );
      }
      // 4. Elenco puntato (- o *)
      else if (/^\s*[-*]\s+/.test(text)) {
        const match = text.match(/^(\s*)([-*])\s+/)!;
        pushAtomicReplace(
          Decoration.replace({ widget: new BulletWidget() }),
          line.from + match[1]!.length,
          line.from + match[0].length,
        );
      }
      // 5. Citazione (> )
      else if (/^>\s*/.test(text)) {
        const match = text.match(/^>\s*/)!;
        ranges.push(quoteLineDeco.range(line.from));
        if (match[0].length > 0) {
          pushAtomicReplace(hiddenSyntax, line.from, line.from + match[0].length);
        }
      }

      // 6. Formattazione inline unificata (Link selezionabili, Grassetto, Corsivo, Barrato, Codice)
      const parsed = parseInlineLine(text, line.from);

      for (const hr of parsed.hiddenRanges) {
        pushAtomicReplace(hiddenSyntax, hr.from, hr.to);
      }

      for (const lnk of parsed.links) {
        if (!lnk.isExternal) {
          const resolved = resolvePage(lnk.target);
          if (!resolved) {
            pushAtomicReplace(hiddenSyntax, lnk.from, lnk.to);
            continue;
          }
          pushAtomicReplace(
            Decoration.replace({
              widget: new InternalLinkWidget(
                resolved.path,
                resolved.displayTitle,
                resolved.icona ?? null,
                (t) => openLink(t),
              ),
            }),
            lnk.from,
            lnk.to,
          );
          continue;
        }

        // Link esterno: testo reale selezionabile + formattabile, sintassi Markdown nascosta
        const linkMark = Decoration.mark({
          class: lnk.standalone
            ? 'cm-notion-link-external-standalone'
            : 'cm-notion-link-text-highlight',
          attributes: {
            'data-external-url': lnk.target,
            'data-link-from': String(lnk.from),
            'data-link-to': String(lnk.to),
          },
        });

        const visFrom = lnk.standalone ? lnk.visibleFrom : lnk.labelFrom;
        const visTo = lnk.standalone ? lnk.visibleTo : lnk.labelTo;

        if (lnk.standalone) {
          if (visFrom > lnk.from) {
            pushAtomicReplace(
              Decoration.replace({
                widget: new FaviconIconWidget(lnk.target, lnk.from, lnk.to),
              }),
              lnk.from,
              visFrom,
            );
          } else {
            ranges.push(
              Decoration.widget({
                widget: new FaviconIconWidget(lnk.target, lnk.from, lnk.to),
                side: -1,
              }).range(lnk.from),
            );
          }
        } else if (visFrom > lnk.from) {
          pushAtomicReplace(hiddenSyntax, lnk.from, visFrom);
        }

        if (visTo > visFrom) {
          ranges.push(linkMark.range(visFrom, visTo));
          if (lnk.bold) ranges.push(boldDeco.range(visFrom, visTo));
          if (lnk.italic) ranges.push(italicDeco.range(visFrom, visTo));
          if (lnk.strike) ranges.push(strikethroughDeco.range(visFrom, visTo));

          if (lnk.type === 'mdlink' && visFrom === lnk.labelFrom && visTo === lnk.labelTo) {
            const inner = parseInlineLine(lnk.rawLabel, lnk.labelFrom);
            for (const ihr of inner.hiddenRanges) {
              pushAtomicReplace(hiddenSyntax, ihr.from, ihr.to);
            }
            emitStyleRuns(inner.cells, 'bold', boldDeco, ranges);
            emitStyleRuns(inner.cells, 'italic', italicDeco, ranges);
            emitStyleRuns(inner.cells, 'strike', strikethroughDeco, ranges);
            emitStyleRuns(inner.cells, 'code', inlineCodeDeco, ranges);
          }
        }

        if (lnk.to > visTo) {
          pushAtomicReplace(hiddenSyntax, visTo, lnk.to);
        }
      }

      emitStyleRuns(parsed.cells, 'bold', boldDeco, ranges);
      emitStyleRuns(parsed.cells, 'italic', italicDeco, ranges);
      emitStyleRuns(parsed.cells, 'strike', strikethroughDeco, ranges);
      emitStyleRuns(parsed.cells, 'code', inlineCodeDeco, ranges);

      pos = line.to + 1;
    }
  }

  return {
    decorations: Decoration.set(ranges, true),
    atomicRanges: Decoration.set(atomicList, true),
  };
}

const notionLivePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomicRanges: DecorationSet;
    constructor(view: EditorView) {
      const built = buildNotionDecorations(view);
      this.decorations = built.decorations;
      this.atomicRanges = built.atomicRanges;
    }
    update(update: ViewUpdate) {
      const forcedRefresh = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(refreshDecorationsEffect)),
      );
      if (
        forcedRefresh ||
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet
      ) {
        const built = buildNotionDecorations(update.view);
        this.decorations = built.decorations;
        this.atomicRanges = built.atomicRanges;
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomicRanges ?? Decoration.none),
  },
);

// ---------------------------------------------------------------------------
// Funzione per applicare la trasformazione di blocco da menu Slash (/) o Toolbar
// ---------------------------------------------------------------------------

function applyBlockTransform(
  view: EditorView,
  lineNum: number,
  prefix: string,
  slashFrom?: number,
  slashTo?: number,
) {
  const line = view.state.doc.line(lineNum);
  let lineText = line.text;

  if (slashFrom !== undefined && slashTo !== undefined) {
    const relFrom = slashFrom - line.from;
    const relTo = slashTo - line.from;
    lineText = lineText.slice(0, relFrom) + lineText.slice(relTo);
  }

  const existingPrefix = lineText.match(BLOCK_PREFIX_RE);
  if (existingPrefix) {
    lineText = lineText.slice(existingPrefix[0].length);
  }

  const newLineText = prefix + lineText.trimStart();
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: newLineText },
    selection: { anchor: line.from + newLineText.length },
  });
  view.focus();
}

// ---------------------------------------------------------------------------
// Gestione della pressione di Invio (separatore ---, continuazione/uscita elenchi)
// ---------------------------------------------------------------------------

function handleEnterKey(view: EditorView): boolean {
  const { state, dispatch } = view;
  const line = state.doc.lineAt(state.selection.main.from);
  const text = line.text;

  // Se il cursore è su una riga separatore '---', crea e sposta subito il cursore sulla riga sotto
  if (!collectCodeBlockLines(view).has(line.number) && /^\s*---+\s*$/.test(text)) {
    dispatch({
      changes: { from: line.from, to: line.to, insert: '---\n' },
      selection: EditorSelection.cursor(line.from + 4),
    });
    return true;
  }

  const emptyListMatch = text.match(/^(\s*)(-\s+\[\s*\]\s*|-\s+|\*\s+|\d+[.)]\s+|>\s*)$/);
  if (emptyListMatch) {
    dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
    });
    return true;
  }

  const listMatch = text.match(/^(\s*)(-\s+\[\s*\]\s*|-\s+|\*\s+|(\d+)([.)])\s+|>\s*)/);
  if (listMatch) {
    const indent = listMatch[1]!;
    const marker = listMatch[2]!;
    let nextMarker = marker;

    if (listMatch[3]) {
      const num = parseInt(listMatch[3], 10) + 1;
      const sep = listMatch[4] || '.';
      nextMarker = `${num}${sep} `;
    } else if (marker.includes('[ ]') || marker.includes('[x]') || marker.includes('[X]')) {
      nextMarker = '- [ ] ';
    }

    const insert = '\n' + indent + nextMarker;
    dispatch({
      changes: { from: state.selection.main.from, insert },
      selection: EditorSelection.cursor(state.selection.main.from + insert.length),
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Gestione intelligente di Backspace e Delete per non esporre mai sintassi raw
// ---------------------------------------------------------------------------

function handleSmartSelectionDelete(view: EditorView): boolean {
  const { state, dispatch } = view;
  const range = state.selection.main;
  if (range.empty) return false;

  const startLine = state.doc.lineAt(range.from);
  const endLine = state.doc.lineAt(range.to);
  if (startLine.number !== endLine.number) return false;

  const parsed = parseInlineLine(startLine.text, startLine.from);

  // Se la selezione copre l'intero testo visibile di un link, elimina l'intero link
  for (const lnk of parsed.links) {
    const visFrom = lnk.standalone ? lnk.visibleFrom : lnk.labelFrom;
    const visTo = lnk.standalone ? lnk.visibleTo : lnk.labelTo;
    if (range.from <= visFrom && range.to >= visTo) {
      const delFrom = Math.min(range.from, lnk.from);
      const delTo = Math.max(range.to, lnk.to);
      dispatch({
        changes: { from: delFrom, to: delTo, insert: '' },
        selection: EditorSelection.cursor(delFrom),
      });
      return true;
    }
  }

  // Se la selezione copre tutto il contenuto tra due delimitatori nascosti (es. **mondo**), elimina anche i delimitatori
  const prevHr = parsed.hiddenRanges.find((h) => h.to === range.from);
  const nextHr = parsed.hiddenRanges.find((h) => h.from === range.to);
  if (prevHr && nextHr) {
    dispatch({
      changes: { from: prevHr.from, to: nextHr.to, insert: '' },
      selection: EditorSelection.cursor(prevHr.from),
    });
    return true;
  }

  return false;
}

function handleBackspaceKey(view: EditorView): boolean {
  const { state, dispatch } = view;
  const range = state.selection.main;
  if (!range.empty) {
    return handleSmartSelectionDelete(view);
  }

  const pos = range.from;
  const line = state.doc.lineAt(pos);

  // 1. Riga separatore '---': elimina il separatore
  if (!collectCodeBlockLines(view).has(line.number) && /^\s*---+\s*$/.test(line.text)) {
    const nextPos = line.to < state.doc.length ? line.to + 1 : line.to;
    dispatch({
      changes: { from: line.from, to: nextPos, insert: '' },
      selection: EditorSelection.cursor(line.from > 0 ? line.from - 1 : 0),
    });
    return true;
  }

  // 2. Rimozione prefisso di blocco (#, -, 1., >) a inizio riga
  const match = line.text.match(BLOCK_PREFIX_RE);
  if (match) {
    const prefixLen = match[0].length;
    if (pos > line.from && pos <= line.from + prefixLen) {
      dispatch({
        changes: { from: line.from, to: line.from + prefixLen, insert: '' },
        selection: EditorSelection.cursor(line.from),
      });
      return true;
    }
  }

  // 3. Protezione confini link (evita di cancellare ')' lasciando '[testo](url' rotto)
  const parsed = parseInlineLine(line.text, line.from);
  for (const lnk of parsed.links) {
    if (!lnk.isExternal) {
      if (pos === lnk.to) {
        dispatch({
          changes: { from: lnk.from, to: lnk.to, insert: '' },
          selection: EditorSelection.cursor(lnk.from),
        });
        return true;
      }
      continue;
    }

    const visFrom = lnk.standalone ? lnk.visibleFrom : lnk.labelFrom;
    const visTo = lnk.standalone ? lnk.visibleTo : lnk.labelTo;
    const innerCells =
      lnk.type === 'mdlink' ? parseInlineLine(lnk.rawLabel, lnk.labelFrom).cells : null;

    // Cursore subito dopo la fine del link (dopo la parte nascosta `](url)`) o sull'ultimo carattere
    if (pos > visTo && pos <= lnk.to) {
      if (innerCells) {
        if (innerCells.length <= 1) {
          dispatch({
            changes: { from: lnk.from, to: lnk.to, insert: '' },
            selection: EditorSelection.cursor(lnk.from),
          });
        } else {
          const lastCell = innerCells[innerCells.length - 1]!;
          dispatch({
            changes: { from: lastCell.origFrom, to: lastCell.origTo, insert: '' },
            selection: EditorSelection.cursor(lastCell.origFrom),
          });
        }
        return true;
      }
      if (visTo - visFrom <= 1) {
        dispatch({
          changes: { from: lnk.from, to: lnk.to, insert: '' },
          selection: EditorSelection.cursor(lnk.from),
        });
      } else {
        dispatch({
          changes: { from: visTo - 1, to: visTo, insert: '' },
          selection: EditorSelection.cursor(visTo - 1),
        });
      }
      return true;
    }

    // Se resta un solo carattere visibile nel link e l'utente preme Backspace subito dopo di esso
    if (innerCells && innerCells.length === 1 && pos === innerCells[0]!.origTo) {
      dispatch({
        changes: { from: lnk.from, to: lnk.to, insert: '' },
        selection: EditorSelection.cursor(lnk.from),
      });
      return true;
    }
    if (!innerCells && visTo - visFrom === 1 && pos === visTo) {
      dispatch({
        changes: { from: lnk.from, to: lnk.to, insert: '' },
        selection: EditorSelection.cursor(lnk.from),
      });
      return true;
    }

    // Cursore all'inizio del testo visibile del link (subito dopo `[` nascosto o icona favicon)
    if (pos > lnk.from && pos <= visFrom) {
      if (lnk.from > line.from) {
        dispatch({
          changes: { from: lnk.from - 1, to: lnk.from, insert: '' },
          selection: EditorSelection.cursor(pos - 1),
        });
        return true;
      }
      if (line.from > 0) {
        dispatch({
          changes: { from: line.from - 1, to: line.from, insert: '' },
          selection: EditorSelection.cursor(pos - 1),
        });
        return true;
      }
      return true;
    }
  }

  // 4. Protezione delimitatori inline nascosti (**, *, ~~, `) per non lasciare mai **** o * orfani
  for (const hr of parsed.hiddenRanges) {
    if (pos === hr.to) {
      const cellBefore = parsed.cells.find((c) => !c.atomic && c.origTo === hr.from);
      if (cellBefore) {
        const openHr = parsed.hiddenRanges.find((h) => h.to === cellBefore.origFrom);
        if (openHr) {
          dispatch({
            changes: { from: openHr.from, to: hr.to, insert: '' },
            selection: EditorSelection.cursor(openHr.from),
          });
        } else {
          dispatch({
            changes: { from: cellBefore.origFrom, to: cellBefore.origTo, insert: '' },
            selection: EditorSelection.cursor(cellBefore.origFrom),
          });
        }
        return true;
      }
      if (hr.from > line.from) {
        dispatch({
          changes: { from: hr.from - 1, to: hr.from, insert: '' },
          selection: EditorSelection.cursor(pos - 1),
        });
        return true;
      }
    }
  }

  // Caso `**m|**` (cursore tra l'ultimo carattere e i delimitatori di chiusura)
  const cellJustBefore = parsed.cells.find((c) => !c.atomic && c.origTo === pos);
  if (cellJustBefore) {
    const openHr = parsed.hiddenRanges.find((h) => h.to === cellJustBefore.origFrom);
    const closeHr = parsed.hiddenRanges.find((h) => h.from === pos);
    if (openHr && closeHr) {
      dispatch({
        changes: { from: openHr.from, to: closeHr.to, insert: '' },
        selection: EditorSelection.cursor(openHr.from),
      });
      return true;
    }
  }

  return false;
}

function handleDeleteKey(view: EditorView): boolean {
  const { state, dispatch } = view;
  const range = state.selection.main;
  if (!range.empty) {
    return handleSmartSelectionDelete(view);
  }

  const pos = range.from;
  const line = state.doc.lineAt(pos);

  if (!collectCodeBlockLines(view).has(line.number) && /^\s*---+\s*$/.test(line.text)) {
    const nextPos = line.to < state.doc.length ? line.to + 1 : line.to;
    dispatch({
      changes: { from: line.from, to: nextPos, insert: '' },
      selection: EditorSelection.cursor(line.from),
    });
    return true;
  }

  const parsed = parseInlineLine(line.text, line.from);
  for (const lnk of parsed.links) {
    if (!lnk.isExternal) {
      if (pos === lnk.from) {
        dispatch({
          changes: { from: lnk.from, to: lnk.to, insert: '' },
          selection: EditorSelection.cursor(lnk.from),
        });
        return true;
      }
      continue;
    }

    const visFrom = lnk.standalone ? lnk.visibleFrom : lnk.labelFrom;
    const visTo = lnk.standalone ? lnk.visibleTo : lnk.labelTo;
    const innerCells =
      lnk.type === 'mdlink' ? parseInlineLine(lnk.rawLabel, lnk.labelFrom).cells : null;

    if (pos >= lnk.from && pos < visFrom) {
      if (innerCells) {
        if (innerCells.length <= 1) {
          dispatch({
            changes: { from: lnk.from, to: lnk.to, insert: '' },
            selection: EditorSelection.cursor(lnk.from),
          });
        } else {
          const firstCell = innerCells[0]!;
          dispatch({
            changes: { from: firstCell.origFrom, to: firstCell.origTo, insert: '' },
            selection: EditorSelection.cursor(firstCell.origFrom),
          });
        }
        return true;
      }
      if (visTo - visFrom <= 1) {
        dispatch({
          changes: { from: lnk.from, to: lnk.to, insert: '' },
          selection: EditorSelection.cursor(lnk.from),
        });
      } else {
        dispatch({
          changes: { from: visFrom, to: visFrom + 1, insert: '' },
          selection: EditorSelection.cursor(visFrom),
        });
      }
      return true;
    }

    if (pos >= visTo && pos < lnk.to) {
      if (lnk.to < state.doc.length) {
        dispatch({
          changes: { from: lnk.to, to: lnk.to + 1, insert: '' },
          selection: EditorSelection.cursor(pos),
        });
      }
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Comandi idempotenti per formattazione inline e helper clipboard URL
// ---------------------------------------------------------------------------

function dispatchMinimalDocChange(
  view: EditorView,
  oldDoc: string,
  nextDoc: string,
  newFrom: number,
  newTo: number,
  focusView = true,
) {
  if (oldDoc === nextDoc) {
    if (focusView) view.focus();
    return;
  }

  let changeFrom = 0;
  const minLen = Math.min(oldDoc.length, nextDoc.length);
  while (changeFrom < minLen && oldDoc.charCodeAt(changeFrom) === nextDoc.charCodeAt(changeFrom)) {
    changeFrom++;
  }

  let oldEnd = oldDoc.length;
  let nextEnd = nextDoc.length;
  while (
    oldEnd > changeFrom &&
    nextEnd > changeFrom &&
    oldDoc.charCodeAt(oldEnd - 1) === nextDoc.charCodeAt(nextEnd - 1)
  ) {
    oldEnd--;
    nextEnd--;
  }

  const clampedFrom = Math.max(0, Math.min(newFrom, nextDoc.length));
  const clampedTo = Math.max(0, Math.min(newTo, nextDoc.length));

  view.dispatch({
    changes: {
      from: changeFrom,
      to: oldEnd,
      insert: nextDoc.slice(changeFrom, nextEnd),
    },
    selection:
      clampedFrom === clampedTo
        ? EditorSelection.cursor(clampedFrom)
        : EditorSelection.range(clampedFrom, clampedTo),
  });
  if (focusView) view.focus();
}

function toggleInlineStyle(view: EditorView, style: InlineStyle) {
  const sel = view.state.selection.main;
  const oldDoc = view.state.doc.toString();
  const res = toggleInlineStyleOnDoc(oldDoc, sel.from, sel.to, style);
  dispatchMinimalDocChange(view, oldDoc, res.text, res.from, res.to);
}

function extractUrlFromClipboard(clipboardData: DataTransfer | null): string | null {
  if (!clipboardData) return null;
  const plain = clipboardData.getData('text/plain')?.trim() ?? '';
  if (
    /^(https?:\/\/|mailto:)[^\s<>]+$/i.test(plain) ||
    /^www\.[^\s<>]+\.[^\s<>]+$/i.test(plain)
  ) {
    return normalizeExternalUrl(plain);
  }
  const uriList = clipboardData
    .getData('text/uri-list')
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (uriList && /^(https?:\/\/|mailto:)[^\s<>]+$/i.test(uriList)) {
    return uriList;
  }
  const html = clipboardData.getData('text/html')?.trim() ?? '';
  if (html) {
    const m = html.match(/^<a\b[^>]*\bhref=["'](https?:\/\/[^"']+|mailto:[^"']+)["'][^>]*>[\s\S]*?<\/a>$/i);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function sanitizeMetaTitle(rawTitle: string): string {
  const clean = rawTitle
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length > 110) {
    return `${clean.slice(0, 109).trimEnd()}…`;
  }
  return clean;
}

function findBareAutolinkInDoc(
  view: EditorView,
  targetUrl: string,
): { from: number; to: number } | null {
  const codeLines = collectCodeBlockLines(view);
  const doc = view.state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    if (codeLines.has(n)) continue;
    const line = doc.line(n);
    if (!line.text.includes(targetUrl)) continue;
    const parsed = parseInlineLine(line.text, line.from);
    const hit = parsed.links.find(
      (l) => l.type === 'autolink' && (l.target === targetUrl || l.raw === targetUrl),
    );
    if (hit) {
      return { from: hit.from, to: hit.to };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Componente Editor Notion Live WYSIWYG
// ---------------------------------------------------------------------------

export function Editor({
  value,
  onChange,
  theme,
  availableNotes,
  entries,
  pages,
  liveTitleDrafts,
  onLiveTitleDraftChange,
  onSaveShortcut,
  onOpenWikilink,
  onRenameTitle,
  onCreateSubpage,
  onPatchFrontmatter: _onPatchFrontmatter,
  onTreeMutated,
  topPanel,
  bottomPanel,
  autoFocusTitle,
  onTitleAutoFocused,
  path,
}: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleInputFocusedRef = useRef(false);
  const renameDebounceRef = useRef<any>(null);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSaveShortcut);
  onSaveRef.current = onSaveShortcut;
  const onOpenRef = useRef(onOpenWikilink);
  onOpenRef.current = onOpenWikilink;
  const onRenameTitleRef = useRef(onRenameTitle);
  onRenameTitleRef.current = onRenameTitle;
  const onLiveTitleDraftChangeRef = useRef(onLiveTitleDraftChange);
  onLiveTitleDraftChangeRef.current = onLiveTitleDraftChange;
  const onCreateSubpageRef = useRef(onCreateSubpage);
  onCreateSubpageRef.current = onCreateSubpage;
  const onTreeMutatedRef = useRef(onTreeMutated);
  onTreeMutatedRef.current = onTreeMutated;
  const notesRef = useRef(availableNotes);
  notesRef.current = availableNotes;

  const pageContextRef = useRef({
    path,
    entries: entries ?? [],
    pages: pages ?? [],
    liveTitleDrafts: liveTitleDrafts ?? {},
  });
  pageContextRef.current = {
    path,
    entries: entries ?? [],
    pages: pages ?? [],
    liveTitleDrafts: liveTitleDrafts ?? {},
  };

  const savedSelectionRef = useRef<{ from: number; to: number } | null>(null);

  const [selectionMenu, setSelectionMenu] = useState<{
    top: number;
    left: number;
    blockMenuOpen: boolean;
    linkInputOpen: boolean;
    linkUrlDraft: string;
    activeStyles: {
      bold: boolean;
      italic: boolean;
      strike: boolean;
      code: boolean;
      wikilink: boolean;
      externalLink: ParsedLink | null;
    };
  } | null>(null);

  const [linkPopover, setLinkPopover] = useState<{
    url: string;
    linkFrom: number;
    linkTo: number;
    standalone: boolean;
    wrapPrefix: string;
    wrapSuffix: string;
    titleDraft: string;
    urlDraft: string;
    top: number;
    left: number;
    copied: boolean;
    pinned: boolean;
    editing: boolean;
  } | null>(null);

  const [createPagePrompt, setCreatePagePrompt] = useState<{
    pos: number;
    title: string;
    top: number;
    left: number;
  } | null>(null);

  const [createDbPrompt, setCreateDbPrompt] = useState<{
    pos: number;
    name: string;
    top: number;
    left: number;
  } | null>(null);

  const [createIndexVistaPrompt, setCreateIndexVistaPrompt] = useState<{
    pos: number;
    fonte: 'sottopagine' | 'discendenti' | 'tutte';
    colonne: string[];
    top: number;
    left: number;
  } | null>(null);

  const [mountedVistaPortals, setMountedVistaPortals] = useState<
    Array<{
      index: number;
      el: HTMLElement;
      block: ExtractedVistaBlock;
    }>
  >([]);

  const linkPopoverRef = useRef(linkPopover);
  linkPopoverRef.current = linkPopover;
  const hoverCloseTimerRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
      if (renameDebounceRef.current) clearTimeout(renameDebounceRef.current);
    };
  }, []);

  // Chiude il popover link fissato/in modifica cliccando fuori o premendo Esc
  useEffect(() => {
    if (!linkPopover) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.notion-link-hover-menu') || target.closest('[data-external-url]')) {
        return;
      }
      setLinkPopover(null);
    };
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLinkPopover(null);
        viewRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [linkPopover !== null]);

  // Separa in modo invisibile eventuale frontmatter esistente: l'editor mostra e modifica SOLO il corpo
  // conservando byte-per-byte prefisso YAML, commenti, virgolette e fine riga (LF / CRLF).
  const { verbatimPrefix, body, docEol } = useMemo(() => {
    const parsed = parseFrontmatter(value);
    let leadingSep = '';
    let cleanBody = parsed.body;
    if (parsed.frontmatter !== null) {
      const sepMatch = /^(\r?\n)+/.exec(parsed.body);
      if (sepMatch) {
        leadingSep = sepMatch[0]!;
        cleanBody = parsed.body.slice(leadingSep.length);
      }
    }
    return {
      verbatimPrefix: parsed.rawPrefix + leadingSep,
      body: cleanBody,
      docEol: parsed.eol,
    };
  }, [value]);

  const verbatimPrefixRef = useRef(verbatimPrefix);
  verbatimPrefixRef.current = verbatimPrefix;
  const docEolRef = useRef(docEol);
  docEolRef.current = docEol;

  const reconstructFullDoc = (nextBody: string): string => {
    const eol = docEolRef.current;
    const prefix = verbatimPrefixRef.current;
    const bodyWithEol = eol === '\r\n' ? nextBody.replace(/\r?\n/g, '\r\n') : nextBody;
    if (prefix.length > 0 && !prefix.endsWith('\n') && bodyWithEol.length > 0) {
      return `${prefix}${eol}${bodyWithEol}`;
    }
    return `${prefix}${bodyWithEol}`;
  };

  const currentPathRef = useRef(path);
  const lastEmittedDocRef = useRef(value);

  const isHome = isHomePage(path);
  const isMdDecoratedPage = Boolean(
    path && path.toLowerCase().endsWith('.md') && path.toLowerCase() !== 'agents.md',
  );

  // Titolo pinnato: sempre identico al nome della nota nella sidebar, sincronizzato bidirezionalmente in tempo reale
  const activePageId = useMemo(() => {
    if (!path || !pages) return null;
    const found = pages.find((p) => p.path.toLowerCase() === path.toLowerCase());
    return found?.id ?? null;
  }, [path, pages]);

  const canonicalFileTitle = path ? getNoteDisplayName(path) : '';
  const [titleDraft, setTitleDraft] = useState(() => {
    if (path && liveTitleDrafts) {
      if (Object.prototype.hasOwnProperty.call(liveTitleDrafts, path)) {
        return liveTitleDrafts[path]!;
      }
      const nodeDir = nodeDirOfPagePath(path);
      if (nodeDir && Object.prototype.hasOwnProperty.call(liveTitleDrafts, nodeDir)) {
        return liveTitleDrafts[nodeDir]!;
      }
    }
    return canonicalFileTitle;
  });

  const prevPathForTitleRef = useRef(path);
  const prevPageIdForTitleRef = useRef(activePageId);

  useEffect(() => {
    const switchedToDifferentNote =
      path !== prevPathForTitleRef.current &&
      (!activePageId || activePageId !== prevPageIdForTitleRef.current);

    prevPathForTitleRef.current = path;
    prevPageIdForTitleRef.current = activePageId;

    const nodeDir = path ? nodeDirOfPagePath(path) : null;
    let externalTitle = canonicalFileTitle;
    if (path && liveTitleDrafts) {
      if (Object.prototype.hasOwnProperty.call(liveTitleDrafts, path)) {
        externalTitle = liveTitleDrafts[path]!;
      } else if (nodeDir && Object.prototype.hasOwnProperty.call(liveTitleDrafts, nodeDir)) {
        externalTitle = liveTitleDrafts[nodeDir]!;
      }
    }

    if (switchedToDifferentNote) {
      if (renameDebounceRef.current) {
        clearTimeout(renameDebounceRef.current);
        renameDebounceRef.current = null;
      }
      titleInputFocusedRef.current = false;
      setTitleDraft(externalTitle);
    } else if (!titleInputFocusedRef.current) {
      setTitleDraft(externalTitle);
    }
  }, [path, activePageId, canonicalFileTitle, liveTitleDrafts]);

  useEffect(() => {
    if (!isHome && autoFocusTitle && titleInputRef.current) {
      titleInputFocusedRef.current = true;
      titleInputRef.current.focus();
      titleInputRef.current.select();
      onTitleAutoFocused?.();
    }
  }, [autoFocusTitle, path, isHome]);

  const handleTitleInputChange = (nextRaw: string) => {
    if (isHome) return;
    setTitleDraft(nextRaw);
    onLiveTitleDraftChangeRef.current?.(nextRaw);

    if (renameDebounceRef.current) {
      clearTimeout(renameDebounceRef.current);
    }
    const targetPathAtKeystroke = path;
    renameDebounceRef.current = setTimeout(() => {
      renameDebounceRef.current = null;
      const cleaned = sanitizeNoteTitleForFilename(nextRaw);
      const curPath = currentPathRef.current ?? targetPathAtKeystroke;
      const curCanonical = curPath ? getNoteDisplayName(curPath) : '';
      if (cleaned && cleaned !== curCanonical) {
        onRenameTitleRef.current?.(cleaned, { fromPath: curPath, live: true });
      }
    }, 450);
  };

  const commitTitle = (finalRaw?: string) => {
    if (isHome) return;
    if (renameDebounceRef.current) {
      clearTimeout(renameDebounceRef.current);
      renameDebounceRef.current = null;
    }
    const raw = finalRaw ?? titleDraft;
    const cleaned = sanitizeNoteTitleForFilename(raw);
    const curCanonical = path ? getNoteDisplayName(path) : '';
    onLiveTitleDraftChangeRef.current?.(null);

    if (!cleaned) {
      setTitleDraft(curCanonical);
      return;
    }
    setTitleDraft(cleaned);
    if (cleaned !== curCanonical) {
      onRenameTitleRef.current?.(cleaned, { fromPath: path, live: false });
    }
  };

  const openPopoverForElement = (linkEl: HTMLElement, pinned: boolean) => {
    const url = linkEl.getAttribute('data-external-url');
    if (!url) return;

    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }

    const attrFrom = Number(linkEl.getAttribute('data-link-from') ?? '-1');
    const attrTo = Number(linkEl.getAttribute('data-link-to') ?? '-1');

    let resolvedFrom = attrFrom;
    let resolvedTo = attrTo;
    let standalone = linkEl.classList.contains('cm-notion-link-external-standalone') ||
      linkEl.classList.contains('cm-link-favicon-wrap');
    let titleDraft = formatStandaloneUrlLabel(url);
    let wrapPrefix = '';
    let wrapSuffix = '';

    const view = viewRef.current;
    if (view && attrFrom >= 0) {
      const docStr = view.state.doc.toString();
      const found =
        findExternalLinkAtPos(docStr, attrFrom) ??
        findExternalLinkAtPos(docStr, Math.min(docStr.length, attrFrom + 1));
      if (found) {
        resolvedFrom = found.from;
        resolvedTo = found.to;
        standalone = found.standalone;
        const extracted = extractEditableLinkTitle(found);
        titleDraft = extracted.cleanTitle;
        wrapPrefix = extracted.wrapPrefix;
        wrapSuffix = extracted.wrapSuffix;
      }
    }

    const rect = linkEl.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow < 64 ? Math.max(12, rect.top - 44) : rect.bottom + 5;
    const left = Math.max(16, Math.min(rect.left, window.innerWidth - 295));

    setLinkPopover((prev) => {
      if (prev?.editing && prev.linkFrom === resolvedFrom && !pinned) {
        return prev;
      }
      if (
        prev &&
        !pinned &&
        prev.url === url &&
        prev.linkFrom === resolvedFrom &&
        Math.abs(prev.top - top) < 4 &&
        Math.abs(prev.left - left) < 4
      ) {
        return prev;
      }
      return {
        url,
        linkFrom: resolvedFrom,
        linkTo: resolvedTo,
        standalone,
        wrapPrefix,
        wrapSuffix,
        titleDraft,
        urlDraft: url,
        top,
        left,
        copied: false,
        pinned: pinned || Boolean(prev?.pinned && prev.linkFrom === resolvedFrom),
        editing: Boolean(prev?.editing && prev.linkFrom === resolvedFrom),
      };
    });
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // 1. Menu Slash Command (/) in stile Notion con tutte le opzioni di blocco
    const slashCompletion = (context: CompletionContext): CompletionResult | null => {
      const match = context.matchBefore(/(?:^|\s)\/([a-zA-Z0-9]*)/);
      if (!match) return null;

      const slashIndex = match.text.lastIndexOf('/');
      const query = match.text.slice(slashIndex + 1).toLowerCase();
      const from = match.from + slashIndex;
      const line = context.state.doc.lineAt(context.pos);

      const blockItems = [
        {
          label: 'Database',
          detail: 'Crea un database con vista a tabella e proprietà tipizzate',
          icon: '⊞',
          hint: 'tabella',
          apply: (view: EditorView) => {
            view.dispatch({
              changes: { from, to: context.pos, insert: '' },
              selection: EditorSelection.cursor(from),
            });
            const coords = view.coordsAtPos(from);
            const top = coords ? Math.min(window.innerHeight - 160, coords.bottom + 6) : 200;
            const left = coords ? Math.max(16, Math.min(coords.left, window.innerWidth - 320)) : 100;
            setCreateDbPrompt({
              pos: from,
              name: 'Nuovo database',
              top,
              left,
            });
          },
        },
        {
          label: 'Indice di pagine',
          detail: 'Vista a tabella su sottopagine, discendenti o tutte le pagine',
          icon: '☰',
          hint: 'vista',
          apply: (view: EditorView) => {
            view.dispatch({
              changes: { from, to: context.pos, insert: '' },
              selection: EditorSelection.cursor(from),
            });
            const coords = view.coordsAtPos(from);
            const top = coords ? Math.min(window.innerHeight - 230, coords.bottom + 6) : 200;
            const left = coords ? Math.max(16, Math.min(coords.left, window.innerWidth - 320)) : 100;
            setCreateIndexVistaPrompt({
              pos: from,
              fonte: 'sottopagine',
              colonne: ['titolo', 'tag', 'creato'],
              top,
              left,
            });
          },
        },
        {
          label: 'Pagina',
          detail: 'Crea una nuova pagina collegata',
          icon: '+',
          hint: 'pagina',
          apply: (view: EditorView) => {
            view.dispatch({
              changes: { from, to: context.pos, insert: '' },
              selection: EditorSelection.cursor(from),
            });
            const coords = view.coordsAtPos(from);
            const top = coords ? Math.min(window.innerHeight - 130, coords.bottom + 6) : 200;
            const left = coords ? Math.max(16, Math.min(coords.left, window.innerWidth - 300)) : 100;
            setCreatePagePrompt({
              pos: from,
              title: '',
              top,
              left,
            });
          },
        },
        {
          label: 'Testo',
          detail: 'Paragrafo',
          icon: '¶',
          hint: '',
          apply: (view: EditorView) => applyBlockTransform(view, line.number, '', from, context.pos),
        },
        {
          label: 'Titolo 1',
          detail: 'Intestazione 1',
          icon: 'H1',
          hint: '#',
          apply: (view: EditorView) =>
            applyBlockTransform(view, line.number, '# ', from, context.pos),
        },
        {
          label: 'Titolo 2',
          detail: 'Intestazione 2',
          icon: 'H2',
          hint: '##',
          apply: (view: EditorView) =>
            applyBlockTransform(view, line.number, '## ', from, context.pos),
        },
        {
          label: 'Titolo 3',
          detail: 'Intestazione 3',
          icon: 'H3',
          hint: '###',
          apply: (view: EditorView) =>
            applyBlockTransform(view, line.number, '### ', from, context.pos),
        },
        {
          label: 'Elenco attività',
          detail: 'To-do checklist',
          icon: '☐',
          hint: '[]',
          apply: (view: EditorView) =>
            applyBlockTransform(view, line.number, '- [ ] ', from, context.pos),
        },
        {
          label: 'Elenco puntato',
          detail: 'Lista non ordinata',
          icon: '•',
          hint: '-',
          apply: (view: EditorView) =>
            applyBlockTransform(view, line.number, '- ', from, context.pos),
        },
        {
          label: 'Elenco numerato 1.',
          detail: 'Lista sequenziale con punto',
          icon: '1.',
          hint: '1.',
          apply: (view: EditorView) =>
            applyBlockTransform(view, line.number, '1. ', from, context.pos),
        },
        {
          label: 'Elenco numerato 1)',
          detail: 'Lista con parentesi tonda',
          icon: '1)',
          hint: '1)',
          apply: (view: EditorView) =>
            applyBlockTransform(view, line.number, '1) ', from, context.pos),
        },
        {
          label: 'Citazione',
          detail: 'Blocco citazione',
          icon: '"',
          hint: '>',
          apply: (view: EditorView) =>
            applyBlockTransform(view, line.number, '> ', from, context.pos),
        },
        {
          label: 'Separatore',
          detail: 'Linea divisoria orizzontale',
          icon: '—',
          hint: '---',
          apply: (view: EditorView) => {
            view.dispatch({
              changes: { from: line.from, to: line.to, insert: '---\n' },
              selection: { anchor: line.from + 4 },
            });
            view.focus();
          },
        },
        {
          label: 'Blocco codice',
          detail: 'Riquadro per codice sorgente',
          icon: '</>',
          hint: '```',
          apply: (view: EditorView) => {
            view.dispatch({
              changes: { from, to: context.pos, insert: '```\n\n```' },
              selection: { anchor: from + 4 },
            });
          },
        },
      ];

      const filtered = blockItems.filter(
        (it) =>
          it.label.toLowerCase().includes(query) ||
          it.detail.toLowerCase().includes(query) ||
          (it.hint && it.hint.toLowerCase().includes(query)),
      );

      return {
        from,
        to: context.pos,
        options: filtered,
        filter: false,
      };
    };

    // 2. Autocompletamento Wikilink con [[ (solo pagine esistenti, connessione immutabile per ID)
    const wikilinkCompletion = (context: CompletionContext): CompletionResult | null => {
      const word = context.matchBefore(/\[\[([^\]]*)/);
      if (!word) return null;

      const query = word.text.slice(2).toLowerCase();
      const ctx = pageContextRef.current;

      if (ctx.pages.length > 0) {
        const activeMdSet = new Set(
          ctx.entries
            .filter((e) => e.type === 'file' && !e.archived && e.path.toLowerCase().endsWith('.md'))
            .map((e) => e.path.toLowerCase()),
        );
        const options = ctx.pages
          .filter((p) => activeMdSet.size === 0 || activeMdSet.has(p.path.toLowerCase()))
          .map((p) => {
            const displayName = getNoteDisplayName(p.path, ctx.liveTitleDrafts);
            return {
              label: displayName,
              detail: p.path,
              apply: `page:${p.id}]]`,
            };
          })
          .filter(
            (opt) =>
              opt.label.toLowerCase().includes(query) ||
              opt.detail.toLowerCase().includes(query),
          );

        return {
          from: word.from + 2,
          options,
          filter: false,
        };
      }

      const options = notesRef.current
        .filter((note) => note.toLowerCase().endsWith('.md') && note.toLowerCase().includes(query))
        .map((note) => {
          const cleanName = getNoteDisplayName(note, ctx.liveTitleDrafts);
          return {
            label: cleanName,
            detail: note,
            apply: `${note.replace(/\.md$/i, '')}]]`,
          };
        });

      return {
        from: word.from + 2,
        options,
        filter: false,
      };
    };

    // 3. Scorciatoie da tastiera e navigazione
    const shortcuts = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          onSaveRef.current?.();
          return true;
        },
      },
      {
        key: 'Mod-b',
        run: (view) => {
          toggleInlineStyle(view, 'bold');
          return true;
        },
      },
      {
        key: 'Mod-i',
        run: (view) => {
          toggleInlineStyle(view, 'italic');
          return true;
        },
      },
      {
        key: 'Mod-e',
        run: (view) => {
          toggleInlineStyle(view, 'code');
          return true;
        },
      },
      {
        key: 'Mod-Shift-s',
        run: (view) => {
          toggleInlineStyle(view, 'strike');
          return true;
        },
      },
      {
        key: 'Mod-k',
        run: (view) => {
          const sel = view.state.selection.main;
          if (sel.empty) return false;
          savedSelectionRef.current = { from: sel.from, to: sel.to };
          setSelectionMenu((prev) =>
            prev
              ? {
                  ...prev,
                  linkInputOpen: true,
                  blockMenuOpen: false,
                  linkUrlDraft: prev.activeStyles.externalLink?.target ?? '',
                }
              : null,
          );
          return true;
        },
      },
      { key: 'Enter', run: (view) => handleEnterKey(view) },
      { key: 'Backspace', run: (view) => handleBackspaceKey(view) },
      { key: 'Delete', run: (view) => handleDeleteKey(view) },
      ...defaultKeymap,
      ...historyKeymap,
    ]);

    // 4. Gestione digitazione su riga `---` (Spazio o caratteri vanno sempre sulla riga sotto)
    const hrInputGuard = EditorView.inputHandler.of((view, from, to, text) => {
      if (from !== to) return false;
      const line = view.state.doc.lineAt(from);
      if (collectCodeBlockLines(view).has(line.number)) return false;

      // Se la riga è già un separatore `---`:
      // - premendo Spazio crea subito la riga vuota sotto e porta il cursore lì
      // - digitando testo (diverso da '-') scrive direttamente sulla riga sotto senza toccare `---`
      if (/^\s*---+\s*$/.test(line.text)) {
        if (text === ' ') {
          view.dispatch({
            changes: { from: line.from, to: line.to, insert: '---\n' },
            selection: EditorSelection.cursor(line.from + 4),
          });
          return true;
        }
        if (text !== '-') {
          if (from === line.from) {
            view.dispatch({
              changes: { from: line.from, insert: `${text}\n` },
              selection: EditorSelection.cursor(line.from + text.length),
            });
          } else {
            view.dispatch({
              changes: { from: line.to, insert: `\n${text}` },
              selection: EditorSelection.cursor(line.to + 1 + text.length),
            });
          }
          return true;
        }
      }

      // Caso IME / inserimento rapido `--` + `- ` in un solo evento
      const prospective =
        line.text.slice(0, from - line.from) + text + line.text.slice(to - line.from);
      if (/^\s*---+\s+$/.test(prospective)) {
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: '---\n' },
          selection: EditorSelection.cursor(line.from + 4),
        });
        return true;
      }

      return false;
    });

    // 5. Gestione prioritaria incolla URL (su selezione -> link blu sottolineato; autonomo -> preview con meta title)
    //    e click sui link esterni (apre menu Copia link + Modifica titolo/link)
    const domHandlers = Prec.highest(
      EditorView.domEventHandlers({
        paste(event, view) {
          const sel = view.state.selection.main;
          const urlCandidate = extractUrlFromClipboard(event.clipboardData);

          // Caso A: Testo già selezionato + URL negli appunti -> trasforma in link sottolineato blu [testo](url)
          if (!sel.empty && urlCandidate) {
            const oldDoc = view.state.doc.toString();
            const res = pasteExternalUrlOnDoc(oldDoc, sel.from, sel.to, urlCandidate);
            if (res) {
              event.preventDefault();
              dispatchMinimalDocChange(view, oldDoc, res.text, res.cursor, res.cursor);
              return true;
            }
          }

          // Caso B: Nessuna selezione + URL singolo HTTP(S) -> incolla e risolve Meta Title + Favicon
          if (sel.empty) {
            const line = view.state.doc.lineAt(sel.from);
            const inCodeBlock = collectCodeBlockLines(view).has(line.number);

            if (!inCodeBlock && urlCandidate && /^https?:\/\//i.test(urlCandidate)) {
              event.preventDefault();
              const isHrLine = /^\s*---+\s*$/.test(line.text);
              const insertAt = isHrLine ? line.to : sel.from;
              const insertedText = isHrLine ? `\n${urlCandidate}` : urlCandidate;

              view.dispatch({
                changes: { from: insertAt, insert: insertedText },
                selection: EditorSelection.cursor(insertAt + insertedText.length),
              });

              // Recupera meta title e favicon della pagina (silenzioso se offline)
              void api.getLinkMeta(urlCandidate).then((meta) => {
                if (meta.favicon) {
                  customFaviconByUrl.set(urlCandidate, meta.favicon);
                  try {
                    customFaviconByOrigin.set(new URL(urlCandidate).origin, meta.favicon);
                  } catch {
                    // ignore
                  }
                }
                if (viewRef.current !== view) return;

                if (meta.title) {
                  const cleanTitle = sanitizeMetaTitle(meta.title);
                  if (cleanTitle) {
                    const bareHit = findBareAutolinkInDoc(view, urlCandidate);
                    if (bareHit) {
                      const replacement = `[${cleanTitle}](${urlCandidate} "preview")`;
                      const curSel = view.state.selection.main;
                      const delta = replacement.length - (bareHit.to - bareHit.from);
                      let nextAnchor = curSel.anchor;
                      let nextHead = curSel.head;
                      if (curSel.from >= bareHit.to) {
                        nextAnchor += delta;
                        nextHead += delta;
                      } else if (curSel.from >= bareHit.from && curSel.to <= bareHit.to) {
                        nextAnchor = bareHit.from + replacement.length;
                        nextHead = nextAnchor;
                      }
                      view.dispatch({
                        changes: {
                          from: bareHit.from,
                          to: bareHit.to,
                          insert: replacement,
                        },
                        selection: EditorSelection.range(nextAnchor, nextHead),
                      });
                      return;
                    }
                  }
                }

                if (meta.favicon) {
                  view.dispatch({});
                }
              });

              return true;
            }

            // Se si incolla testo normale mentre il cursore è su una riga `---`, incolla sotto `---`
            if (!inCodeBlock && /^\s*---+\s*$/.test(line.text)) {
              const plain = event.clipboardData?.getData('text/plain');
              if (plain) {
                event.preventDefault();
                view.dispatch({
                  changes: { from: line.to, insert: `\n${plain}` },
                  selection: EditorSelection.cursor(line.to + 1 + plain.length),
                });
                return true;
              }
            }
          }

          return false;
        },
        scroll() {
          if (!linkPopoverRef.current?.editing) {
            setLinkPopover(null);
          }
          return false;
        },
        click(event, view) {
          const target = event.target as HTMLElement | null;
          const extLinkEl = target?.closest?.('[data-external-url]') as HTMLElement | null;
          if (extLinkEl) {
            const url = extLinkEl.getAttribute('data-external-url');
            if (url && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              window.open(url, '_blank', 'noopener,noreferrer');
              return true;
            }
            // Se non è stata trascinata una selezione di testo, il click fissa il menu Copia link + Modifica
            if (view.state.selection.main.empty) {
              openPopoverForElement(extLinkEl, true);
            }
            return false;
          }

          if (event.ctrlKey || event.metaKey || event.altKey) {
            const coords = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (coords === null) return false;
            const line = view.state.doc.lineAt(coords);
            const col = coords - line.from;
            const regex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
            let m;
            while ((m = regex.exec(line.text)) !== null) {
              if (col >= m.index && col <= m.index + m[0].length) {
                event.preventDefault();
                onOpenRef.current?.(m[1]!.trim());
                return true;
              }
            }
          }
          return false;
        },
      }),
    );

    const state = EditorState.create({
      doc: body,
      extensions: [
        history(),
        markdown(),
        openWikilinkFacet.of((target) => onOpenRef.current?.(target)),
        resolvePageFacet.of((rawTarget) => {
          const ctx = pageContextRef.current;
          const effectiveEntries: readonly TreeEntry[] =
            ctx.entries.length > 0
              ? ctx.entries
              : notesRef.current.map((p) => ({
                  path: p,
                  type: 'file' as const,
                  size: 0,
                  mtimeMs: 0,
                  archived: false,
                }));
          if (effectiveEntries.length === 0) return null;
          return resolveInternalPageTarget(
            rawTarget,
            ctx.path,
            effectiveEntries,
            ctx.pages,
            ctx.liveTitleDrafts,
          );
        }),
        autocompletion({
          override: [slashCompletion, wikilinkCompletion],
          activateOnTyping: true,
          closeOnBlur: false,
          icons: false,
          addToOptions: [
            {
              render: (completion: any) => {
                if (!completion.icon) return null;
                const iconEl = document.createElement('span');
                iconEl.className = 'cm-slash-icon';
                iconEl.textContent = completion.icon;
                return iconEl;
              },
              position: 20,
            },
            {
              render: (completion: any) => {
                if (!completion.hint) return null;
                const hintEl = document.createElement('span');
                hintEl.className = 'cm-slash-hint';
                hintEl.textContent = completion.hint;
                return hintEl;
              },
              position: 80,
            },
          ],
        }),
        hrInputGuard,
        shortcuts,
        domHandlers,
        vistaPortalFacet.of({
          onMount(index, el, block) {
            setMountedVistaPortals((prev) => {
              const filtered = prev.filter((p) => p.index !== index && p.el !== el);
              return [...filtered, { index, el, block }];
            });
          },
          onUnmount(_index, el) {
            setMountedVistaPortals((prev) => prev.filter((p) => p.el !== el));
          },
        }),
        vistaBlockStateField,
        notionLivePlugin,
        placeholder("Scrivi del testo o digita '/' per scegliere un blocco..."),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged || update.viewportChanged) {
            const sel = update.state.selection.main;
            if (!sel.empty && sel.to > sel.from) {
              savedSelectionRef.current = { from: sel.from, to: sel.to };
              const coords = update.view.coordsAtPos(sel.from);
              const activeStyles = getActiveInlineStyles(
                update.state.doc.toString(),
                sel.from,
                sel.to,
              );
              if (coords) {
                const top = coords.top - 72 < 48 ? coords.bottom + 8 : coords.top - 72;
                setSelectionMenu((prev) => ({
                  top,
                  left: Math.max(20, Math.min(coords.left, window.innerWidth - 310)),
                  blockMenuOpen: prev?.blockMenuOpen || false,
                  linkInputOpen: prev?.linkInputOpen || false,
                  linkUrlDraft: prev?.linkInputOpen
                    ? prev.linkUrlDraft
                    : (activeStyles.externalLink?.target ?? ''),
                  activeStyles,
                }));
              } else {
                setSelectionMenu((prev) => (prev ? { ...prev, activeStyles } : null));
              }
            } else {
              savedSelectionRef.current = null;
              setSelectionMenu(null);
            }
          }

          if (update.docChanged) {
            let slashInserted = false;
            update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
              if (inserted.toString().includes('/')) {
                slashInserted = true;
              }
            });

            if (slashInserted) {
              setTimeout(() => {
                startCompletion(update.view);
              }, 10);
            }

            const nextBody = update.state.doc.toString();
            const ctx = pageContextRef.current;
            const effectiveEntries: readonly TreeEntry[] =
              ctx.entries.length > 0
                ? ctx.entries
                : notesRef.current.map((p) => ({
                    path: p,
                    type: 'file' as const,
                    size: 0,
                    mtimeMs: 0,
                    archived: false,
                  }));

            if (effectiveEntries.length > 0) {
              const purgedBody = purgeMissingInternalLinksFromMarkdown(
                nextBody,
                ctx.path,
                effectiveEntries,
                ctx.pages,
              );
              if (purgedBody !== nextBody) {
                const curSel = update.state.selection.main;
                queueMicrotask(() => {
                  if (viewRef.current !== update.view) return;
                  const latestDoc = update.view.state.doc.toString();
                  const latestCtx = pageContextRef.current;
                  const latestEntries: readonly TreeEntry[] =
                    latestCtx.entries.length > 0
                      ? latestCtx.entries
                      : notesRef.current.map((p) => ({
                          path: p,
                          type: 'file' as const,
                          size: 0,
                          mtimeMs: 0,
                          archived: false,
                        }));
                  const rePurged = purgeMissingInternalLinksFromMarkdown(
                    latestDoc,
                    latestCtx.path,
                    latestEntries,
                    latestCtx.pages,
                  );
                  if (rePurged !== latestDoc) {
                    dispatchMinimalDocChange(
                      update.view,
                      latestDoc,
                      rePurged,
                      curSel.from,
                      curSel.to,
                      false,
                    );
                  }
                });
                return;
              }
            }

            const fullDoc = reconstructFullDoc(nextBody);
            lastEmittedDocRef.current = fullDoc;
            onChangeRef.current(fullDoc);
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [theme]);

  // Sincronizza se il file cambia dall'esterno (es. cambio scheda o ricaricamento)
  useEffect(() => {
    const isNewFile = path !== currentPathRef.current;
    currentPathRef.current = path;

    if (!isNewFile && value === lastEmittedDocRef.current) {
      return;
    }

    lastEmittedDocRef.current = value;
    const view = viewRef.current;
    if (!view) return;

    const parsed = parseFrontmatter(value);
    let targetBody = parsed.body;
    if (parsed.frontmatter !== null) {
      const sepMatch = /^(\r?\n)+/.exec(parsed.body);
      if (sepMatch) {
        targetBody = parsed.body.slice(sepMatch[0]!.length);
      }
    }
    const currentDoc = view.state.doc.toString();

    if (targetBody !== currentDoc) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: targetBody },
      });
    }
  }, [path, value]);

  // Aggiorna in tempo reale il testo di preview dei link interni e rimuove eventuali link a pagine eliminate
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    if (entries && entries.length > 0) {
      const currentDoc = view.state.doc.toString();
      const purged = purgeMissingInternalLinksFromMarkdown(
        currentDoc,
        path,
        entries,
        pages ?? [],
      );
      if (purged !== currentDoc) {
        const sel = view.state.selection.main;
        dispatchMinimalDocChange(view, currentDoc, purged, sel.from, sel.to, false);
        return;
      }
    }

    view.dispatch({ effects: refreshDecorationsEffect.of(null) });
  }, [entries, pages, liveTitleDrafts, path]);

  const getCurrentBlockLabel = () => {
    const view = viewRef.current;
    if (!view) return 'Testo normale';
    const range = view.state.selection.main;
    const line = view.state.doc.lineAt(range.from);
    const text = line.text;
    if (text.startsWith('# ')) return 'Titolo 1';
    if (text.startsWith('## ')) return 'Titolo 2';
    if (/^#{3,6}\s+/.test(text)) return 'Titolo 3';
    if (/^\s*-\s+\[([ xX])\]/.test(text)) return 'Elenco attività';
    if (/^\s*[-*]\s+/.test(text)) return 'Elenco puntato';
    if (/^\s*\d+\.\s+/.test(text)) return 'Elenco numerato 1.';
    if (/^\s*\d+\)\s+/.test(text)) return 'Elenco numerato 1)';
    if (/^>\s*/.test(text)) return 'Citazione';
    return 'Testo normale';
  };

  const applyBlockFromFloating = (prefix: string) => {
    const view = viewRef.current;
    if (!view) return;
    const range = view.state.selection.main;
    const line = view.state.doc.lineAt(range.from);
    applyBlockTransform(view, line.number, prefix);
    setSelectionMenu(null);
  };

  const handleEditorMouseOver = (e: React.MouseEvent<HTMLDivElement>) => {
    const linkEl = (e.target as HTMLElement | null)?.closest?.(
      '[data-external-url]',
    ) as HTMLElement | null;
    if (!linkEl) return;
    openPopoverForElement(linkEl, false);
  };

  const handleEditorMouseOut = (e: React.MouseEvent<HTMLDivElement>) => {
    const linkEl = (e.target as HTMLElement | null)?.closest?.('[data-external-url]');
    if (!linkEl) return;
    if (linkPopoverRef.current?.pinned || linkPopoverRef.current?.editing) {
      return;
    }
    const related = e.relatedTarget as HTMLElement | null;
    if (related && (linkEl.contains(related) || related.closest?.('.notion-link-hover-menu'))) {
      return;
    }
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = setTimeout(() => {
      setLinkPopover((prev) => (prev?.pinned || prev?.editing ? prev : null));
    }, 180);
  };

  const handleCopyPopoverLink = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!linkPopover) return;
    try {
      await navigator.clipboard.writeText(linkPopover.url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = linkPopover.url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setLinkPopover((prev) => (prev ? { ...prev, copied: true } : null));
    if (!linkPopover.editing) {
      if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = setTimeout(() => {
        setLinkPopover((prev) => (prev?.editing ? prev : null));
      }, 900);
    }
  };

  const handleToggleEditPopover = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLinkPopover((prev) => {
      if (!prev) return null;
      const nextEditing = !prev.editing;
      const adjustedTop =
        nextEditing && prev.top + 195 > window.innerHeight
          ? Math.max(12, window.innerHeight - 205)
          : prev.top;
      return {
        ...prev,
        pinned: true,
        editing: nextEditing,
        top: adjustedTop,
      };
    });
  };

  const handleSavePopoverLink = (e?: React.FormEvent) => {
    e?.preventDefault();
    const view = viewRef.current;
    if (!view || !linkPopover || linkPopover.linkFrom < 0) {
      setLinkPopover(null);
      return;
    }

    const oldDoc = view.state.doc.toString();
    const current =
      findExternalLinkAtPos(oldDoc, linkPopover.linkFrom) ??
      findExternalLinkAtPos(oldDoc, Math.min(oldDoc.length, linkPopover.linkFrom + 1));
    const from = current ? current.from : linkPopover.linkFrom;
    const to = current ? current.to : linkPopover.linkTo;

    const cleanTitle = linkPopover.titleDraft.trim() || formatStandaloneUrlLabel(linkPopover.urlDraft);
    const wrappedTitle = `${linkPopover.wrapPrefix}${cleanTitle}${linkPopover.wrapSuffix}`;

    const res = updateExistingLinkOnDoc(
      oldDoc,
      from,
      to,
      wrappedTitle,
      linkPopover.urlDraft,
      linkPopover.standalone,
    );
    setLinkPopover(null);
    dispatchMinimalDocChange(view, oldDoc, res.text, res.cursor, res.cursor);
  };

  const handleRemovePopoverLink = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const view = viewRef.current;
    if (!view || !linkPopover || linkPopover.linkFrom < 0) {
      setLinkPopover(null);
      return;
    }

    const oldDoc = view.state.doc.toString();
    const current =
      findExternalLinkAtPos(oldDoc, linkPopover.linkFrom) ??
      findExternalLinkAtPos(oldDoc, Math.min(oldDoc.length, linkPopover.linkFrom + 1));
    const from = current ? current.from : linkPopover.linkFrom;
    const to = current ? current.to : linkPopover.linkTo;
    const cleanTitle = linkPopover.titleDraft.trim() || formatStandaloneUrlLabel(linkPopover.url);
    const wrappedTitle = `${linkPopover.wrapPrefix}${cleanTitle}${linkPopover.wrapSuffix}`;

    const res = updateExistingLinkOnDoc(oldDoc, from, to, wrappedTitle, '', false);
    setLinkPopover(null);
    dispatchMinimalDocChange(view, oldDoc, res.text, res.cursor, res.cursor);
  };

  const applySelectionLink = (urlToApply: string) => {
    const view = viewRef.current;
    if (!view) return;
    const sel = savedSelectionRef.current ?? view.state.selection.main;
    const oldDoc = view.state.doc.toString();
    const res = applyExternalLinkOnDoc(oldDoc, sel.from, sel.to, urlToApply);
    setSelectionMenu((prev) => (prev ? { ...prev, linkInputOpen: false } : null));
    dispatchMinimalDocChange(view, oldDoc, res.text, res.from, res.to);
  };

  const handleConfirmCreatePagePrompt = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!createPagePrompt) return;
    const view = viewRef.current;
    const promptPos = createPagePrompt.pos;
    const chosenTitle = createPagePrompt.title.trim();
    setCreatePagePrompt(null);

    if (!onCreateSubpageRef.current) return;
    onCreateSubpageRef.current((token: string) => {
      if (!view) return lastEmittedDocRef.current;
      const curLen = view.state.doc.length;
      const safePos = Math.max(0, Math.min(promptPos, curLen));
      const insertStr = `${token} `;
      view.dispatch({
        changes: { from: safePos, to: safePos, insert: insertStr },
        selection: EditorSelection.cursor(safePos + insertStr.length),
      });
      view.focus();
      const nextBody = view.state.doc.toString();
      const fullDoc = reconstructFullDoc(nextBody);
      lastEmittedDocRef.current = fullDoc;
      return fullDoc;
    }, chosenTitle);
  };

  const handleConfirmCreateDbPrompt = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!createDbPrompt) return;
    const view = viewRef.current;
    const promptPos = createDbPrompt.pos;
    const chosenName = createDbPrompt.name.trim() || 'Nuovo database';
    setCreateDbPrompt(null);

    try {
      const hostPathToUse = path || '_index.md';
      const res = await api.createDatabase({
        hostPath: hostPathToUse,
        name: chosenName,
      });
      if (view) {
        const curLen = view.state.doc.length;
        const safePos = Math.max(0, Math.min(promptPos, curLen));
        const needsLeadingNl = safePos > 0 && view.state.doc.sliceString(safePos - 1, safePos) !== '\n';
        const insertStr = `${needsLeadingNl ? '\n' : ''}${res.vistaBlock}\n`;
        view.dispatch({
          changes: { from: safePos, to: safePos, insert: insertStr },
          selection: EditorSelection.cursor(safePos + insertStr.length),
        });
      }
      await onTreeMutatedRef.current?.(res.convertedHost);
    } catch (err) {
      console.error('Errore creazione database:', err);
    }
  };

  const handleConfirmCreateIndexVistaPrompt = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!createIndexVistaPrompt) return;
    const view = viewRef.current;
    const promptPos = createIndexVistaPrompt.pos;
    const { fonte, colonne } = createIndexVistaPrompt;
    setCreateIndexVistaPrompt(null);

    const blockMarkdown = serializeVistaBlock({
      fonte,
      colonne: colonne.length > 0 ? colonne : ['titolo', 'tag', 'creato'],
    });
    if (view) {
      const curLen = view.state.doc.length;
      const safePos = Math.max(0, Math.min(promptPos, curLen));
      const needsLeadingNl = safePos > 0 && view.state.doc.sliceString(safePos - 1, safePos) !== '\n';
      const insertStr = `${needsLeadingNl ? '\n' : ''}${blockMarkdown}\n`;
      view.dispatch({
        changes: { from: safePos, to: safePos, insert: insertStr },
        selection: EditorSelection.cursor(safePos + insertStr.length),
      });
      view.focus();
    }
  };

  return (
    <div
      className="editor-pane notion-mode"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
    >
      <div className="notion-scroll-area">
        {/* Titolo pinnato della nota (identico e sincronizzato in tempo reale con il nome nella sidebar) */}
        <div
          className="notion-page-header"
          style={isMdDecoratedPage ? { paddingTop: '32px' } : undefined}
        >
          <input
            ref={titleInputRef}
            type="text"
            className="notion-page-title-input"
            value={isHome ? 'Home' : titleDraft}
            readOnly={isHome}
            title={isHome ? 'La Home mantiene il nome fisso' : undefined}
            placeholder="Senza titolo"
            spellCheck={false}
            style={isHome ? { cursor: 'default' } : undefined}
            onFocus={() => {
              if (!isHome) titleInputFocusedRef.current = true;
            }}
            onChange={(e) => handleTitleInputChange(e.target.value)}
            onBlur={() => {
              titleInputFocusedRef.current = false;
              commitTitle();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                titleInputFocusedRef.current = false;
                commitTitle();
                viewRef.current?.focus();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                if (renameDebounceRef.current) {
                  clearTimeout(renameDebounceRef.current);
                  renameDebounceRef.current = null;
                }
                titleInputFocusedRef.current = false;
                setTitleDraft(canonicalFileTitle);
                onLiveTitleDraftChangeRef.current?.(null);
                viewRef.current?.focus();
              }
            }}
          />
        </div>

        {/* Pannello proprietà opzionale (Fase 2) */}
        {topPanel}

        {/* Vista tabella intera quando si apre direttamente _index.md di un database */}
        {bottomPanel}

        {/* Canvas di scrittura visiva diretta */}
        <div
          ref={containerRef}
          onMouseOver={handleEditorMouseOver}
          onMouseOut={handleEditorMouseOut}
          style={{
            flex: 1,
            minHeight: '300px',
            position: 'relative',
          }}
        />
      </div>

      {/* Portali React per i blocchi ```vista e legacy ![[page:...]] dentro il documento */}
      {mountedVistaPortals.map((portal) =>
        createPortal(
          <TableViewWidget
            key={`vista-portal-${portal.index}`}
            hostPath={path || '_index.md'}
            parsedBlock={portal.block.parsed}
            isLegacyEmbed={portal.block.kind === 'legacy-embed'}
            rawBlock={portal.block.rawBlock}
            onOpenPage={(targetPath) => onOpenRef.current?.(targetPath)}
            onTreeMutated={(conv) => onTreeMutatedRef.current?.(conv)}
            onSaveVistaBlock={async (newVistaBlockMarkdown) => {
              const view = viewRef.current;
              if (!view) return;
              const currentDoc = view.state.doc.toString();
              const nextDoc = replaceVistaBlockInMarkdown(
                currentDoc,
                portal.block.index,
                newVistaBlockMarkdown,
              );
              if (nextDoc !== currentDoc) {
                view.dispatch({
                  changes: { from: 0, to: currentDoc.length, insert: nextDoc },
                });
              }
            }}
            onEditRawYaml={
              portal.block.kind === 'vista'
                ? () => {
                    const view = viewRef.current;
                    if (!view) return;
                    const insidePos = Math.min(
                      portal.block.toOffset - 1,
                      portal.block.fromOffset + 9,
                    );
                    view.dispatch({
                      selection: EditorSelection.cursor(insidePos),
                    });
                    view.focus();
                  }
                : undefined
            }
          />,
          portal.el,
        ),
      )}

      {/* Menu rapido in Hover e al Click sui link (preview e normali): Copia link + Modifica titolo e URL */}
      {linkPopover && !selectionMenu && (
        <div
          className="notion-link-hover-menu"
          style={{
            position: 'fixed',
            top: `${linkPopover.top}px`,
            left: `${linkPopover.left}px`,
          }}
          onMouseEnter={() => {
            if (hoverCloseTimerRef.current) {
              clearTimeout(hoverCloseTimerRef.current);
              hoverCloseTimerRef.current = null;
            }
          }}
          onMouseLeave={() => {
            if (linkPopover.pinned || linkPopover.editing) return;
            if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
            hoverCloseTimerRef.current = setTimeout(() => {
              setLinkPopover((prev) => (prev?.pinned || prev?.editing ? prev : null));
            }, 150);
          }}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).tagName !== 'INPUT') {
              e.preventDefault();
            }
          }}
        >
          <div className="notion-link-hover-actions">
            <button
              type="button"
              className="notion-link-hover-btn"
              onClick={handleCopyPopoverLink}
            >
              {linkPopover.copied ? <Check size={14} /> : <Link size={14} />}
              <span>{linkPopover.copied ? 'Link copiato' : 'Copia link'}</span>
            </button>

            <div className="notion-link-hover-divider" />

            <button
              type="button"
              className={`notion-link-hover-btn ${linkPopover.editing ? 'active' : ''}`}
              onClick={handleToggleEditPopover}
            >
              <Pencil size={13} />
              <span>Modifica</span>
            </button>

            <button
              type="button"
              className="notion-link-hover-btn icon-only"
              title="Apri link nel browser"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                window.open(linkPopover.url, '_blank', 'noopener,noreferrer');
              }}
            >
              <ExternalLink size={13} />
            </button>
          </div>

          {linkPopover.editing && (
            <form className="notion-link-edit-form" onSubmit={handleSavePopoverLink}>
              <div className="notion-link-edit-field">
                <label className="notion-link-edit-label">Titolo link</label>
                <input
                  type="text"
                  className="notion-link-edit-input"
                  value={linkPopover.titleDraft}
                  placeholder="Titolo del link"
                  autoFocus
                  onChange={(e) =>
                    setLinkPopover((prev) =>
                      prev ? { ...prev, titleDraft: e.target.value } : null,
                    )
                  }
                />
              </div>
              <div className="notion-link-edit-field">
                <label className="notion-link-edit-label">Link</label>
                <input
                  type="text"
                  className="notion-link-edit-input"
                  value={linkPopover.urlDraft}
                  placeholder="https://..."
                  onChange={(e) =>
                    setLinkPopover((prev) =>
                      prev ? { ...prev, urlDraft: e.target.value } : null,
                    )
                  }
                />
              </div>
              <div className="notion-link-edit-footer">
                <button
                  type="button"
                  className="notion-link-edit-btn danger"
                  onClick={handleRemovePopoverLink}
                  title="Rimuovi link mantenendo il testo"
                >
                  <Trash2 size={12} />
                  <span>Rimuovi</span>
                </button>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    className="notion-link-edit-btn"
                    onClick={() => {
                      setLinkPopover(null);
                      viewRef.current?.focus();
                    }}
                  >
                    Annulla
                  </button>
                  <button type="submit" className="notion-link-edit-btn primary">
                    Salva
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Popover inserimento/rinomina nome pagina da comando "/" */}
      {createPagePrompt && (
        <div
          className="notion-link-hover-menu notion-create-page-popover"
          style={{
            position: 'fixed',
            top: `${createPagePrompt.top}px`,
            left: `${createPagePrompt.left}px`,
            zIndex: 1050,
          }}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).tagName !== 'INPUT') {
              e.preventDefault();
            }
          }}
        >
          <form className="notion-link-edit-form" style={{ marginTop: 0, borderTop: 'none', padding: '6px' }} onSubmit={handleConfirmCreatePagePrompt}>
            <div className="notion-link-edit-field">
              <label className="notion-link-edit-label">Nome della nuova pagina</label>
              <input
                type="text"
                className="notion-link-edit-input"
                placeholder="es. Progetto, Appunti..."
                value={createPagePrompt.title}
                autoFocus
                onChange={(e) =>
                  setCreatePagePrompt((prev) => (prev ? { ...prev, title: e.target.value } : null))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setCreatePagePrompt(null);
                    viewRef.current?.focus();
                  }
                }}
              />
            </div>
            <div className="notion-link-edit-footer" style={{ marginTop: '4px' }}>
              <button
                type="button"
                className="notion-link-edit-btn"
                onClick={() => {
                  setCreatePagePrompt(null);
                  viewRef.current?.focus();
                }}
              >
                Annulla
              </button>
              <button type="submit" className="notion-link-edit-btn primary">
                Crea pagina
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Popover creazione Database da comando "/Database" */}
      {createDbPrompt && (
        <div
          className="notion-link-hover-menu notion-create-page-popover"
          style={{
            position: 'fixed',
            top: `${createDbPrompt.top}px`,
            left: `${createDbPrompt.left}px`,
            zIndex: 1050,
            minWidth: 280,
          }}
        >
          <form
            className="notion-link-edit-form"
            style={{ marginTop: 0, borderTop: 'none', padding: '8px' }}
            onSubmit={(e) => void handleConfirmCreateDbPrompt(e)}
          >
            <div className="notion-link-edit-field">
              <label className="notion-link-edit-label">Nome del database</label>
              <input
                type="text"
                className="notion-link-edit-input"
                placeholder="Nuovo database"
                value={createDbPrompt.name}
                autoFocus
                onChange={(e) =>
                  setCreateDbPrompt((prev) => (prev ? { ...prev, name: e.target.value } : null))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setCreateDbPrompt(null);
                    viewRef.current?.focus();
                  }
                }}
              />
            </div>
            <div className="notion-link-edit-footer" style={{ marginTop: '6px' }}>
              <button
                type="button"
                className="notion-link-edit-btn"
                onClick={() => {
                  setCreateDbPrompt(null);
                  viewRef.current?.focus();
                }}
              >
                Annulla
              </button>
              <button type="submit" className="notion-link-edit-btn primary">
                Crea database
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Popover creazione Indice di pagine da comando "/Indice di pagine" */}
      {createIndexVistaPrompt && (
        <div
          className="notion-link-hover-menu notion-create-page-popover"
          style={{
            position: 'fixed',
            top: `${createIndexVistaPrompt.top}px`,
            left: `${createIndexVistaPrompt.left}px`,
            zIndex: 1050,
            minWidth: 300,
          }}
        >
          <form
            className="notion-link-edit-form"
            style={{ marginTop: 0, borderTop: 'none', padding: '8px' }}
            onSubmit={handleConfirmCreateIndexVistaPrompt}
          >
            <div className="notion-link-edit-field">
              <label className="notion-link-edit-label">Fonte delle pagine</label>
              <select
                className="notion-link-edit-input"
                value={createIndexVistaPrompt.fonte}
                onChange={(e) =>
                  setCreateIndexVistaPrompt((prev) =>
                    prev
                      ? {
                          ...prev,
                          fonte: e.target.value as 'sottopagine' | 'discendenti' | 'tutte',
                        }
                      : null,
                  )
                }
              >
                <option value="sottopagine">Sottopagine dirette</option>
                <option value="discendenti">Tutte le pagine discendenti</option>
                <option value="tutte">Tutte le pagine della KB</option>
              </select>
            </div>
            <div className="notion-link-edit-field" style={{ marginTop: 6 }}>
              <label className="notion-link-edit-label">Colonne iniziali</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[
                  { key: 'tag', label: 'Tag' },
                  { key: 'creato', label: 'Creato il' },
                  { key: 'modificato', label: 'Modificato il' },
                  { key: 'percorso', label: 'Percorso' },
                ].map((col) => (
                  <label key={col.key} className="notion-popover-check-row">
                    <input
                      type="checkbox"
                      checked={createIndexVistaPrompt.colonne.includes(col.key)}
                      onChange={(e) => {
                        setCreateIndexVistaPrompt((prev) => {
                          if (!prev) return null;
                          const next = e.target.checked
                            ? [...prev.colonne, col.key]
                            : prev.colonne.filter((k) => k !== col.key);
                          return { ...prev, colonne: next };
                        });
                      }}
                    />
                    <span>{col.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="notion-link-edit-footer" style={{ marginTop: '8px' }}>
              <button
                type="button"
                className="notion-link-edit-btn"
                onClick={() => {
                  setCreateIndexVistaPrompt(null);
                  viewRef.current?.focus();
                }}
              >
                Annulla
              </button>
              <button type="submit" className="notion-link-edit-btn primary">
                Inserisci vista
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Pannello Mobile in Selezione con toggle idempotente delle formattazioni + strumento Link */}
      {selectionMenu && (
        <div
          className="notion-floating-toolbar"
          style={{
            position: 'fixed',
            top: `${selectionMenu.top}px`,
            left: `${selectionMenu.left}px`,
          }}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).tagName !== 'INPUT') {
              e.preventDefault();
            }
          }}
        >
          {/* Riga 1: Selettore Blocco (T Testo normale >) */}
          <div className="notion-floating-top-row">
            <button
              className="notion-floating-block-btn"
              onClick={() =>
                setSelectionMenu((prev) =>
                  prev
                    ? { ...prev, blockMenuOpen: !prev.blockMenuOpen, linkInputOpen: false }
                    : null,
                )
              }
              title="Trasforma tipo blocco"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span className="notion-floating-block-icon">T</span>
                <span>{getCurrentBlockLabel()}</span>
              </div>
              <ChevronRight
                size={13}
                style={{
                  transform: selectionMenu.blockMenuOpen ? 'rotate(90deg)' : 'none',
                  transition: 'transform 0.15s ease',
                }}
              />
            </button>
          </div>

          {/* Riga 2: Azioni di formattazione (B, I, S, </> | Link esterno, Nota interna) */}
          <div className="notion-floating-actions-row">
            <button
              className={`notion-floating-action-btn ${selectionMenu.activeStyles.bold ? 'active' : ''}`}
              onClick={() => {
                if (viewRef.current) toggleInlineStyle(viewRef.current, 'bold');
              }}
              title="Grassetto (Ctrl+B)"
            >
              <strong>B</strong>
            </button>
            <button
              className={`notion-floating-action-btn ${selectionMenu.activeStyles.italic ? 'active' : ''}`}
              onClick={() => {
                if (viewRef.current) toggleInlineStyle(viewRef.current, 'italic');
              }}
              title="Corsivo (Ctrl+I)"
            >
              <em>I</em>
            </button>
            <button
              className={`notion-floating-action-btn ${selectionMenu.activeStyles.strike ? 'active' : ''}`}
              onClick={() => {
                if (viewRef.current) toggleInlineStyle(viewRef.current, 'strike');
              }}
              title="Barrato (Ctrl+Shift+S)"
            >
              <s>S</s>
            </button>
            <button
              className={`notion-floating-action-btn ${selectionMenu.activeStyles.code ? 'active' : ''}`}
              onClick={() => {
                if (viewRef.current) toggleInlineStyle(viewRef.current, 'code');
              }}
              title="Codice inline (Ctrl+E)"
            >
              <Code size={13} />
            </button>

            <div className="notion-floating-divider" />

            <button
              className={`notion-floating-action-btn ${
                selectionMenu.activeStyles.externalLink || selectionMenu.linkInputOpen
                  ? 'active'
                  : ''
              }`}
              onClick={() =>
                setSelectionMenu((prev) =>
                  prev
                    ? {
                        ...prev,
                        linkInputOpen: !prev.linkInputOpen,
                        blockMenuOpen: false,
                        linkUrlDraft: prev.activeStyles.externalLink?.target ?? '',
                      }
                    : null,
                )
              }
              title="Aggiungi o modifica link esterno (Ctrl+K)"
            >
              <Link size={13} />
            </button>
          </div>

          {/* Barra inserimento rapido URL nello strumento Link della selezione */}
          {selectionMenu.linkInputOpen && (
            <form
              className="notion-floating-link-bar"
              onSubmit={(e) => {
                e.preventDefault();
                applySelectionLink(selectionMenu.linkUrlDraft);
              }}
            >
              <input
                type="text"
                className="notion-floating-link-input"
                placeholder="Incolla o scrivi un link..."
                value={selectionMenu.linkUrlDraft}
                autoFocus
                onChange={(e) =>
                  setSelectionMenu((prev) =>
                    prev ? { ...prev, linkUrlDraft: e.target.value } : null,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectionMenu((prev) =>
                      prev ? { ...prev, linkInputOpen: false } : null,
                    );
                    viewRef.current?.focus();
                  }
                }}
              />
              <button type="submit" className="notion-floating-link-apply">
                Applica
              </button>
              {selectionMenu.activeStyles.externalLink && (
                <button
                  type="button"
                  className="notion-floating-link-remove"
                  title="Rimuovi link"
                  onClick={() => applySelectionLink('')}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </form>
          )}

          {/* Menu a tendina 'Trasforma in' per i tipi di blocco */}
          {selectionMenu.blockMenuOpen && (
            <div className="notion-floating-dropdown">
              <div className="notion-floating-dropdown-header">Trasforma in</div>
              <button onClick={() => applyBlockFromFloating('')}>
                <span className="dropdown-type-icon">¶</span> Testo normale
              </button>
              <button onClick={() => applyBlockFromFloating('# ')}>
                <span className="dropdown-type-icon">H1</span> Titolo 1
              </button>
              <button onClick={() => applyBlockFromFloating('## ')}>
                <span className="dropdown-type-icon">H2</span> Titolo 2
              </button>
              <button onClick={() => applyBlockFromFloating('### ')}>
                <span className="dropdown-type-icon">H3</span> Titolo 3
              </button>
              <button onClick={() => applyBlockFromFloating('- ')}>
                <span className="dropdown-type-icon">•</span> Elenco puntato
              </button>
              <button onClick={() => applyBlockFromFloating('1. ')}>
                <span className="dropdown-type-icon">1.</span> Elenco numerato 1.
              </button>
              <button onClick={() => applyBlockFromFloating('1) ')}>
                <span className="dropdown-type-icon">1)</span> Elenco numerato 1)
              </button>
              <button onClick={() => applyBlockFromFloating('- [ ] ')}>
                <span className="dropdown-type-icon">☐</span> Elenco attività
              </button>
              <button onClick={() => applyBlockFromFloating('> ')}>
                <span className="dropdown-type-icon">"</span> Citazione
              </button>
              <button
                onClick={() => {
                  if (viewRef.current) {
                    const sel = viewRef.current.state.selection.main;
                    viewRef.current.dispatch({
                      changes: [
                        { from: sel.from, insert: '```\n' },
                        { from: sel.to, insert: '\n```' },
                      ],
                    });
                    setSelectionMenu(null);
                  }
                }}
              >
                <span className="dropdown-type-icon">&lt;/&gt;</span> Blocco codice
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
