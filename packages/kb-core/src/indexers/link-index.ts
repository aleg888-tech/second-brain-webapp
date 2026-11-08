import type { Backlink, OutgoingLink, TagInfo } from '@brain/shared';
import { createResolver, parseTags, parseWikilinks, type ParsedWikilink, type ResolvableFile } from './markdown.js';
import type { IndexDoc, Indexer } from './registry.js';

interface DocInfo {
  path: string;
  archived: boolean;
  links: ParsedWikilink[];
  lines: string[];
  tags: string[];
}

export class LinkTagIndexer implements Indexer {
  readonly name = 'links';
  private readonly docs = new Map<string, DocInfo>();

  accepts(path: string): boolean {
    return path.toLowerCase().endsWith('.md');
  }

  upsert(doc: IndexDoc): void {
    this.docs.set(doc.path, {
      path: doc.path,
      archived: doc.archived,
      links: parseWikilinks(doc.content),
      lines: doc.content.split(/\r?\n/),
      tags: parseTags(doc.content),
    });
  }

  remove(path: string): void {
    this.docs.delete(path);
  }

  clear(): void {
    this.docs.clear();
  }

  size(): number {
    return this.docs.size;
  }

  outgoing(path: string, files: readonly ResolvableFile[]): OutgoingLink[] {
    const doc = this.docs.get(path);
    if (!doc) return [];
    const resolve = createResolver(files);
    return doc.links.map((l) => {
      const r = resolve(l.target, path);
      return {
        raw: l.raw,
        target: l.target,
        alias: l.alias,
        heading: l.heading,
        path: r.path,
        status: r.status,
        line: l.line,
      };
    });
  }

  backlinks(path: string, files: readonly ResolvableFile[]): Backlink[] {
    const resolve = createResolver(files);
    const out: Backlink[] = [];
    for (const doc of this.docs.values()) {
      if (doc.archived || doc.path === path) continue;
      for (const l of doc.links) {
        if (resolve(l.target, doc.path).path === path) {
          out.push({ path: doc.path, line: l.line, context: (doc.lines[l.line - 1] ?? '').trim().slice(0, 240) });
        }
      }
    }
    return out.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  }

  tagsOf(path: string): string[] {
    return this.docs.get(path)?.tags ?? [];
  }

  allTags(): TagInfo[] {
    const map = new Map<string, string[]>();
    for (const doc of this.docs.values()) {
      if (doc.archived) continue;
      for (const t of doc.tags) {
        const list = map.get(t) ?? [];
        list.push(doc.path);
        map.set(t, list);
      }
    }
    return [...map.entries()]
      .map(([tag, paths]) => ({ tag, count: paths.length, paths: paths.sort() }))
      .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
  }
}
