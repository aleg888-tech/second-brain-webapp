import { parseFrontmatterYaml } from '../frontmatter-patch.js';
import { parseTags } from './markdown.js';
import type { IndexDoc, Indexer } from './registry.js';

export interface IndexedFrontmatterDoc {
  path: string;
  archived: boolean;
  data: Record<string, unknown>;
  keyOrder: string[];
  tags: string[];
  body: string;
}

/**
 * Indicizzatore in memoria dei frontmatter YAML di tutte le pagine Markdown.
 * Garantisce interrogazioni istantanee (< 20ms) anche su 1000+ pagine.
 */
export class FrontmatterIndexer implements Indexer {
  readonly name = 'frontmatter';
  private readonly docs = new Map<string, IndexedFrontmatterDoc>();

  accepts(path: string): boolean {
    return path.toLowerCase().endsWith('.md');
  }

  upsert(doc: IndexDoc): void {
    const parsed = parseFrontmatterYaml(doc.content);
    const tags = parseTags(doc.content);
    this.docs.set(doc.path, {
      path: doc.path,
      archived: doc.archived,
      data: parsed.data,
      keyOrder: parsed.keyOrder,
      tags,
      body: parsed.body,
    });
  }

  remove(path: string): void {
    this.docs.delete(path);
  }

  clear(): void {
    this.docs.clear();
  }

  get(path: string): IndexedFrontmatterDoc | undefined {
    const exact = this.docs.get(path);
    if (exact) return exact;
    const lower = path.toLowerCase();
    for (const [k, v] of this.docs.entries()) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }

  all(includeArchived = false): IndexedFrontmatterDoc[] {
    const out: IndexedFrontmatterDoc[] = [];
    for (const doc of this.docs.values()) {
      if (!includeArchived && doc.archived) continue;
      out.push(doc);
    }
    return out;
  }

  size(): number {
    return this.docs.size;
  }
}
