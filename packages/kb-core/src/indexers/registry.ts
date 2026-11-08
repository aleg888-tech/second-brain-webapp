export interface IndexDoc {
  path: string;
  content: string;
  archived: boolean;
}

export interface Indexer {
  readonly name: string;
  accepts(path: string): boolean;
  upsert(doc: IndexDoc): void;
  remove(path: string): void;
  clear(): void;
}

export class IndexerRegistry {
  private readonly indexers: Indexer[] = [];

  register(indexer: Indexer): this {
    if (this.indexers.some((i) => i.name === indexer.name)) {
      throw new Error(`Indicizzatore "${indexer.name}" già registrato.`);
    }
    this.indexers.push(indexer);
    return this;
  }

  get<T extends Indexer>(name: string): T | undefined {
    return this.indexers.find((i) => i.name === name) as T | undefined;
  }

  all(): readonly Indexer[] {
    return this.indexers;
  }

  wants(path: string): boolean {
    return this.indexers.some((i) => i.accepts(path));
  }

  upsert(doc: IndexDoc): void {
    for (const i of this.indexers) if (i.accepts(doc.path)) i.upsert(doc);
  }

  remove(path: string): void {
    for (const i of this.indexers) i.remove(path);
  }

  clear(): void {
    for (const i of this.indexers) i.clear();
  }
}
