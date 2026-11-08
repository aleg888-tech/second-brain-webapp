export interface StorageEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtimeMs: number;
}

export interface StoredFile {
  content: string;
  size: number;
  mtimeMs: number;
}

export interface WriteOptions {
  baseVersion?: string;
}

export interface Storage {
  list(): Promise<StorageEntry[]>;
  stat(path: string): Promise<StorageEntry | null>;
  read(path: string): Promise<StoredFile>;
  write(path: string, content: string, opts?: WriteOptions): Promise<StorageEntry>;
  create(path: string, content: string): Promise<StorageEntry>;
  createDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  archive(path: string, archiveDir: string): Promise<string>;
  delete(path: string): Promise<void>;
}

export { MemoryStorage } from './memory-storage.js';
