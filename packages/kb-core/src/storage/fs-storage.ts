import { promises as fs } from 'node:fs';
import path from 'node:path';
import { alreadyExists, AppError, badRequest, conflict, forbidden, invalidPath, notFound } from '../errors.js';
import { computeVersion, detectEol } from '../text.js';
import { basename, dirname, extOf, joinRel } from './paths.js';
import type { Storage, StorageEntry, StoredFile, WriteOptions } from './storage.js';

const IS_WINDOWS = process.platform === 'win32';

function isErrno(e: unknown, ...codes: string[]): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && codes.includes(String((e as { code: unknown }).code));
}

export class FsStorage implements Storage {
  private readonly root: string;
  private rootRealPromise: Promise<string> | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private rootReal(): Promise<string> {
    this.rootRealPromise ??= fs.realpath(this.root);
    return this.rootRealPromise;
  }

  private static within(root: string, abs: string): boolean {
    const r = IS_WINDOWS ? root.toLowerCase() : root;
    const a = IS_WINDOWS ? abs.toLowerCase() : abs;
    return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  }

  private async resolve(rel: string): Promise<string> {
    const root = await this.rootReal();
    const abs = rel === '' ? root : path.resolve(root, ...rel.split('/'));
    if (!FsStorage.within(root, abs)) throw invalidPath('Il percorso esce dalla knowledge base.');

    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (!FsStorage.within(root, real)) {
          throw forbidden('Il percorso esce dalla knowledge base (collegamento simbolico).');
        }
        return abs;
      } catch (e) {
        if (e instanceof AppError) throw e;
        if (!isErrno(e, 'ENOENT', 'ENOTDIR')) throw e;
        const parent = path.dirname(probe);
        if (parent === probe || !FsStorage.within(root, parent)) return abs;
        probe = parent;
      }
    }
  }

  async list(): Promise<StorageEntry[]> {
    const root = await this.rootReal();
    const out: StorageEntry[] = [];
    const walk = async (relDir: string): Promise<void> => {
      const absDir = relDir === '' ? root : path.join(root, ...relDir.split('/'));
      let dirents;
      try {
        dirents = await fs.readdir(absDir, { withFileTypes: true });
      } catch (e) {
        if (isErrno(e, 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM')) return;
        throw e;
      }
      for (const d of dirents) {
        if (d.name.startsWith('.')) continue;
        if (d.isSymbolicLink()) continue;
        const rel = joinRel(relDir, d.name);
        const abs = path.join(absDir, d.name);
        if (d.isDirectory()) {
          const st = await fs.stat(abs).catch(() => null);
          if (!st) continue;
          out.push({ path: rel, type: 'dir', size: 0, mtimeMs: st.mtimeMs });
          await walk(rel);
        } else if (d.isFile()) {
          const st = await fs.stat(abs).catch(() => null);
          if (!st) continue;
          out.push({ path: rel, type: 'file', size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    };
    await walk('');
    return out;
  }

  async stat(rel: string): Promise<StorageEntry | null> {
    const abs = await this.resolve(rel);
    try {
      const st = await fs.stat(abs);
      return {
        path: rel,
        type: st.isDirectory() ? 'dir' : 'file',
        size: st.isDirectory() ? 0 : st.size,
        mtimeMs: st.mtimeMs,
      };
    } catch (e) {
      if (isErrno(e, 'ENOENT', 'ENOTDIR')) return null;
      throw e;
    }
  }

  async read(rel: string): Promise<StoredFile> {
    const abs = await this.resolve(rel);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) throw badRequest(`"${rel}" è una cartella, non un file.`);
      const content = await fs.readFile(abs, 'utf8');
      return { content, size: st.size, mtimeMs: st.mtimeMs };
    } catch (e) {
      if (isErrno(e, 'ENOENT', 'ENOTDIR')) throw notFound(`Il file "${rel}" non esiste.`);
      throw e;
    }
  }

  async write(rel: string, content: string, opts: WriteOptions = {}): Promise<StorageEntry> {
    const abs = await this.resolve(rel);
    const current = await this.read(rel);
    if (opts.baseVersion !== undefined) {
      const version = await computeVersion(current.content);
      if (version !== opts.baseVersion) {
        throw conflict('Il file è stato modificato nel frattempo.', {
          path: rel,
          content: current.content,
          version,
          eol: detectEol(current.content),
          size: current.size,
          mtimeMs: current.mtimeMs,
        });
      }
    }
    await fs.writeFile(abs, content, 'utf8');
    return this.entryOf(rel, abs);
  }

  async create(rel: string, content: string): Promise<StorageEntry> {
    const abs = await this.resolve(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await this.resolve(rel);
    try {
      await fs.writeFile(abs, content, { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
      if (isErrno(e, 'EEXIST')) throw alreadyExists(`"${rel}" esiste già.`);
      throw e;
    }
    return this.entryOf(rel, abs);
  }

  async createDir(rel: string): Promise<void> {
    const abs = await this.resolve(rel);
    if (await this.stat(rel)) throw alreadyExists(`"${rel}" esiste già.`);
    await fs.mkdir(abs, { recursive: true });
  }

  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;
    const absFrom = await this.resolve(from);
    const absTo = await this.resolve(to);
    if (!(await this.stat(from))) throw notFound(`"${from}" non esiste.`);
    const sameIgnoringCase = from.toLowerCase() === to.toLowerCase();
    if (!sameIgnoringCase && (await this.stat(to))) throw alreadyExists(`"${to}" esiste già.`);
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await this.resolve(to);
    if (sameIgnoringCase) {
      const tmpAbs = `${absFrom}.__brain_case_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      await fs.rename(absFrom, tmpAbs);
      await fs.rename(tmpAbs, absTo);
      return;
    }
    await fs.rename(absFrom, absTo);
  }

  async archive(rel: string, archiveDir: string): Promise<string> {
    const entry = await this.stat(rel);
    if (!entry) throw notFound(`"${rel}" non esiste.`);
    const ext = entry.type === 'file' ? extOf(rel) : '';
    const name = basename(rel);
    const stem = ext ? name.slice(0, -ext.length) : name;
    const parent = joinRel(archiveDir, dirname(rel));
    for (let n = 1; n < 1000; n++) {
      const candidate = joinRel(parent, n === 1 ? name : `${stem}-${n}${ext}`);
      if (!(await this.stat(candidate))) {
        await this.rename(rel, candidate);
        return candidate;
      }
    }
    throw alreadyExists('Impossibile trovare un nome libero in archivio.');
  }

  async delete(rel: string): Promise<void> {
    const abs = await this.resolve(rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st) return;
    if (st.isDirectory()) {
      await fs.rm(abs, { recursive: true, force: true });
    } else {
      await fs.unlink(abs);
    }
  }

  private async entryOf(rel: string, abs: string): Promise<StorageEntry> {
    const st = await fs.stat(abs);
    return { path: rel, type: 'file', size: st.size, mtimeMs: st.mtimeMs };
  }
}
