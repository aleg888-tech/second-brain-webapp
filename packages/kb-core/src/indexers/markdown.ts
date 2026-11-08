import { parseFrontmatterYaml } from '../frontmatter-patch.js';

export type FmValue = string | boolean | string[] | null;

export interface Frontmatter {
  data: Record<string, FmValue>;
  raw: string | null;
  body: string;
  bodyStartLine: number;
}

const FM_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function scalar(v: string): FmValue {
  const t = v.trim();
  if (t === '') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  return unquote(t);
}

export function parseSimpleYaml(raw: string): Record<string, FmValue> {
  const data: Record<string, FmValue> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^\s:#][^:]*?):(?:\s+(.*))?$/.exec(lines[i] ?? '');
    if (!m) continue;
    const key = m[1]!.trim();
    const value = (m[2] ?? '').trim();
    if (value === '') {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1] ?? '')) {
        i++;
        items.push(unquote((lines[i] ?? '').replace(/^\s*-\s+/, '')));
      }
      data[key] = items.length > 0 ? items : null;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map(unquote)
        .filter((s) => s !== '');
    } else {
      data[key] = scalar(value);
    }
  }
  return data;
}

export function splitFrontmatter(text: string): Frontmatter {
  const t = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const m = FM_RE.exec(t);
  if (!m) return { data: {}, raw: null, body: text, bodyStartLine: 0 };
  const raw = m[1] ?? '';
  return {
    data: parseSimpleYaml(raw),
    raw,
    body: t.slice(m[0].length),
    bodyStartLine: (m[0].match(/\n/g) ?? []).length,
  };
}

export function maskCode(text: string): string {
  const lines = text.split('\n');
  let fence: string | null = null;
  const out = lines.map((line) => {
    const fm = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fm && fm[1]!.startsWith(fence)) fence = null;
      return ' '.repeat(line.length);
    }
    if (fm) {
      fence = fm[1]!;
      return ' '.repeat(line.length);
    }
    return line.replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length));
  });
  return out.join('\n');
}

export interface ParsedWikilink {
  raw: string;
  target: string;
  heading: string | null;
  alias: string | null;
  embed: boolean;
  index: number;
  line: number;
}

const WIKILINK_RE = /(!?)\[\[([^[\]\n]+?)\]\]/g;

export function parseWikilinks(text: string): ParsedWikilink[] {
  const masked = maskCode(text);
  const out: ParsedWikilink[] = [];
  let line = 1;
  let last = 0;
  for (const m of masked.matchAll(WIKILINK_RE)) {
    const index = m.index ?? 0;
    for (let i = last; i < index; i++) if (masked.charCodeAt(i) === 10) line++;
    last = index;
    const inner = m[2]!.replace(/\\\|/g, '|');
    const pipe = inner.indexOf('|');
    const left = pipe === -1 ? inner : inner.slice(0, pipe);
    const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null;
    const hash = left.indexOf('#');
    const target = (hash === -1 ? left : left.slice(0, hash)).trim();
    const heading = hash === -1 ? null : left.slice(hash + 1).trim() || null;
    if (!target) continue;
    out.push({ raw: text.slice(index, index + m[0].length), target, heading, alias, embed: m[1] === '!', index, line });
  }
  return out;
}

const INLINE_TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

function normTag(t: string): string {
  return t.trim().replace(/^#/, '').toLowerCase();
}

export function parseTags(text: string): string[] {
  const fm = splitFrontmatter(text);
  const fullFm = parseFrontmatterYaml(text);
  const tags = new Set<string>();
  for (const key of ['tag', 'tags']) {
    const v = fullFm.data[key] ?? fm.data[key];
    const list = Array.isArray(v)
      ? v.map((x) => String(x ?? ''))
      : typeof v === 'string'
        ? v.split(/[,\s]+/)
        : [];
    for (const t of list) {
      const n = normTag(t);
      if (n) tags.add(n);
    }
  }
  for (const m of maskCode(fm.body).matchAll(INLINE_TAG_RE)) {
    const n = normTag(m[2]!);
    if (n) tags.add(n);
  }
  return [...tags].sort();
}

export interface ResolvableFile {
  path: string;
  archived: boolean;
}

export interface Resolution {
  path: string | null;
  status: 'ok' | 'broken' | 'archived';
}

function base(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
function dir(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}
function stripMd(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p;
}

export function createResolver(files: readonly ResolvableFile[]): (target: string, from: string) => Resolution {
  const byPath = new Map<string, ResolvableFile>();
  const byName = new Map<string, ResolvableFile[]>();
  const add = (key: string, f: ResolvableFile) => {
    const list = byName.get(key);
    if (list) {
      if (!list.includes(f)) list.push(f);
    } else byName.set(key, [f]);
  };
  for (const f of files) {
    byPath.set(f.path.toLowerCase(), f);
    const b = base(f.path).toLowerCase();
    add(b, f);
    add(stripMd(b), f);
  }

  const pick = (cands: ResolvableFile[], from: string): ResolvableFile | undefined => {
    const fromDir = dir(from).toLowerCase();
    return [...cands].sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      const as = dir(a.path).toLowerCase() === fromDir ? 0 : 1;
      const bs = dir(b.path).toLowerCase() === fromDir ? 0 : 1;
      if (as !== bs) return as - bs;
      if (a.path.length !== b.path.length) return a.path.length - b.path.length;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    })[0];
  };

  const result = (f: ResolvableFile | undefined): Resolution =>
    f ? { path: f.path, status: f.archived ? 'archived' : 'ok' } : { path: null, status: 'broken' };

  return (rawTarget: string, from: string): Resolution => {
    const t = rawTarget.trim().replace(/^\/+/, '');
    if (!t) return result(undefined);
    const variants = [t, `${t}.md`].map((v) => v.toLowerCase());
    if (t.includes('/')) {
      for (const v of variants) {
        const hit = byPath.get(v);
        if (hit) return result(hit);
      }
      const fromDir = dir(from).toLowerCase();
      if (fromDir) {
        for (const v of variants) {
          const hit = byPath.get(`${fromDir}/${v}`);
          if (hit) return result(hit);
        }
      }
      const suffix = files.filter((f) => variants.some((v) => f.path.toLowerCase().endsWith(`/${v}`)));
      return result(pick(suffix, from));
    }
    const cands = byName.get(t.toLowerCase()) ?? [];
    return result(pick(cands, from));
  };
}
