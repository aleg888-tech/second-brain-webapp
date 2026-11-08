import { invalidPath } from '../errors.js';

const MAX_PATH_LENGTH = 512;
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;

export type PathKind = 'file' | 'dir' | 'any';

export interface NormalizeOptions {
  kind: PathKind;
  extensions: readonly string[];
  /** Ammette "" come radice della KB (solo per cartelle). */
  allowRoot?: boolean;
}

export function normalizeRelPath(input: unknown, opts: NormalizeOptions): string {
  if (typeof input !== 'string') throw invalidPath('Percorso mancante o non valido.');
  if (input.length > MAX_PATH_LENGTH) throw invalidPath('Percorso troppo lungo.');
  if (input === '') {
    if (opts.allowRoot && opts.kind !== 'file') return '';
    throw invalidPath('Percorso vuoto.');
  }
  if (input.includes('\\')) throw invalidPath('Separatore "\\" non ammesso: usa "/".');
  if (input.includes('%')) throw invalidPath('Codifiche nel percorso (es. %2e) non ammesse.');
  if (input.startsWith('/') || /^[a-zA-Z]:/.test(input)) {
    throw invalidPath('Percorsi assoluti non ammessi: usa un percorso relativo alla knowledge base.');
  }
  if (FORBIDDEN_CHARS.test(input)) throw invalidPath('Il percorso contiene caratteri non ammessi.');

  const segments = input.split('/');
  for (const seg of segments) {
    if (seg === '') throw invalidPath('Il percorso contiene segmenti vuoti.');
    if (seg === '.' || seg === '..') throw invalidPath('Segmenti "." e ".." non ammessi.');
    if (seg.toLowerCase() === '.git') throw invalidPath('La cartella .git non è accessibile.');
    if (seg.startsWith('.')) throw invalidPath('Nomi che iniziano con "." non ammessi.');
    if (/^\s|[\s.]$/.test(seg)) throw invalidPath('I nomi non possono iniziare con spazi né finire con spazio o punto.');
    const base = seg.split('.')[0] ?? seg;
    if (RESERVED_WINDOWS.test(base)) throw invalidPath(`"${seg}" è un nome riservato di Windows.`);
  }

  const normalized = segments.join('/');
  if (opts.kind === 'file') {
    const ext = extOf(normalized);
    if (!opts.extensions.includes(ext)) {
      throw invalidPath(`Estensione non ammessa${ext ? ` (${ext})` : ''}: usa ${opts.extensions.join(', ')}.`);
    }
  }
  return normalized;
}

export function extOf(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function joinRel(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/');
}

export function isUnder(path: string, dir: string): boolean {
  if (dir === '') return true;
  const p = path.toLowerCase();
  const d = dir.toLowerCase();
  return p === d || p.startsWith(`${d}/`);
}

export function cleanConfigDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}
