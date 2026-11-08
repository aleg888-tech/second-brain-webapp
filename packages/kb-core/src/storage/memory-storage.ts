import { alreadyExists, notFound } from '../errors.js';
import { utf8ByteLength } from '../text.js';
import { dirname, joinRel } from './paths.js';
import type { Storage, StorageEntry, StoredFile, WriteOptions } from './storage.js';

export class MemoryStorage implements Storage {
  private files = new Map<string, { content: string; mtimeMs: number }>();
  private dirs = new Set<string>();

  constructor() {
    this.dirs.add('');
  }

  private findFileKeyIgnoreCase(target: string): string | null {
    if (this.files.has(target)) return target;
    const lower = target.toLowerCase();
    for (const k of this.files.keys()) {
      if (k.toLowerCase() === lower) return k;
    }
    return null;
  }

  private findDirKeyIgnoreCase(target: string): string | null {
    if (this.dirs.has(target)) return target;
    const lower = target.toLowerCase();
    for (const d of this.dirs) {
      if (d.toLowerCase() === lower) return d;
    }
    return null;
  }

  private existsIgnoreCase(target: string): boolean {
    return this.findFileKeyIgnoreCase(target) !== null || this.findDirKeyIgnoreCase(target) !== null;
  }

  async list(): Promise<StorageEntry[]> {
    const entries: StorageEntry[] = [];
    for (const d of this.dirs) {
      if (d !== '') {
        entries.push({ path: d, type: 'dir', size: 0, mtimeMs: 0 });
      }
    }
    for (const [p, f] of this.files) {
      entries.push({
        path: p,
        type: 'file',
        size: utf8ByteLength(f.content),
        mtimeMs: f.mtimeMs,
      });
    }
    return entries;
  }

  async stat(path: string): Promise<StorageEntry | null> {
    const fk = this.findFileKeyIgnoreCase(path);
    if (fk !== null) {
      const f = this.files.get(fk)!;
      return {
        path: fk,
        type: 'file',
        size: utf8ByteLength(f.content),
        mtimeMs: f.mtimeMs,
      };
    }
    const dk = this.findDirKeyIgnoreCase(path);
    if (dk !== null) {
      return { path: dk, type: 'dir', size: 0, mtimeMs: 0 };
    }
    return null;
  }

  async read(path: string): Promise<StoredFile> {
    const fk = this.findFileKeyIgnoreCase(path);
    if (fk === null) throw notFound(`"${path}" non trovato.`);
    const f = this.files.get(fk)!;
    return {
      content: f.content,
      size: utf8ByteLength(f.content),
      mtimeMs: f.mtimeMs,
    };
  }

  async write(path: string, content: string, _opts?: WriteOptions): Promise<StorageEntry> {
    const fk = this.findFileKeyIgnoreCase(path);
    if (fk === null) throw notFound(`"${path}" non trovato.`);
    const now = Date.now();
    this.files.set(fk, { content, mtimeMs: now });
    return {
      path: fk,
      type: 'file',
      size: utf8ByteLength(content),
      mtimeMs: now,
    };
  }

  async create(path: string, content: string): Promise<StorageEntry> {
    if (this.existsIgnoreCase(path)) {
      throw alreadyExists(`"${path}" esiste già.`);
    }
    let cur = dirname(path);
    while (cur) {
      if (this.findDirKeyIgnoreCase(cur) === null) {
        this.dirs.add(cur);
      }
      cur = dirname(cur);
    }
    const now = Date.now();
    this.files.set(path, { content, mtimeMs: now });
    return {
      path,
      type: 'file',
      size: utf8ByteLength(content),
      mtimeMs: now,
    };
  }

  async createDir(path: string): Promise<void> {
    if (this.existsIgnoreCase(path)) {
      throw alreadyExists(`"${path}" esiste già.`);
    }
    let cur = path;
    while (cur) {
      if (this.findDirKeyIgnoreCase(cur) === null) {
        this.dirs.add(cur);
      }
      cur = dirname(cur);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;
    const sameIgnoringCase = from.toLowerCase() === to.toLowerCase();
    if (!sameIgnoringCase && this.existsIgnoreCase(to)) {
      throw alreadyExists(`"${to}" esiste già.`);
    }
    const fk = this.findFileKeyIgnoreCase(from);
    if (fk !== null) {
      const data = this.files.get(fk)!;
      this.files.delete(fk);
      let cur = dirname(to);
      while (cur) {
        if (this.findDirKeyIgnoreCase(cur) === null) {
          this.dirs.add(cur);
        }
        cur = dirname(cur);
      }
      this.files.set(to, data);
      return;
    }
    const dk = this.findDirKeyIgnoreCase(from);
    if (dk !== null) {
      this.dirs.delete(dk);
      let cur = dirname(to);
      while (cur) {
        if (this.findDirKeyIgnoreCase(cur) === null) {
          this.dirs.add(cur);
        }
        cur = dirname(cur);
      }
      this.dirs.add(to);
      const prefixLower = dk.toLowerCase() + '/';
      for (const [k, v] of [...this.files.entries()]) {
        if (k.toLowerCase().startsWith(prefixLower)) {
          this.files.delete(k);
          this.files.set(to + '/' + k.slice(dk.length + 1), v);
        }
      }
      for (const d of [...this.dirs]) {
        if (d.toLowerCase().startsWith(prefixLower)) {
          this.dirs.delete(d);
          this.dirs.add(to + '/' + d.slice(dk.length + 1));
        }
      }
      return;
    }
    throw notFound(`"${from}" non trovato.`);
  }

  async archive(path: string, archiveDir: string): Promise<string> {
    const isDir = this.dirs.has(path);
    const isFile = this.files.has(path);
    if (!isDir && !isFile) throw notFound(`"${path}" non trovato.`);

    let dest = joinRel(archiveDir, path);
    let counter = 1;
    while (this.files.has(dest) || this.dirs.has(dest)) {
      const dot = dest.lastIndexOf('.');
      if (dot !== -1 && isFile) {
        dest = `${dest.slice(0, dot)}-${counter}${dest.slice(dot)}`;
      } else {
        dest = `${dest}-${counter}`;
      }
      counter++;
    }

    await this.rename(path, dest);
    return dest;
  }

  async delete(rel: string): Promise<void> {
    const clean = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    this.files.delete(clean);
    this.dirs.delete(clean);
    for (const k of Array.from(this.files.keys())) {
      if (k.startsWith(clean + '/')) this.files.delete(k);
    }
    for (const d of Array.from(this.dirs.keys())) {
      if (d.startsWith(clean + '/')) this.dirs.delete(d);
    }
  }
}
