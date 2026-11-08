import { describe, expect, it } from 'vitest';
import type { PageIdentity, TreeEntry } from '@brain/shared';
import {
  buildUnifiedPageTree,
  getNoteDisplayName,
  resolveInternalPageTarget,
} from '../src/core/pages.js';

describe('Fase 1 Web — Albero unificato di pagine-nodo', () => {
  const entries: TreeEntry[] = [
    { path: '_index.md', type: 'file', size: 120, mtimeMs: 1, archived: false },
    { path: 'domini', type: 'dir', size: 0, mtimeMs: 1, archived: false },
    { path: 'domini/corsa', type: 'dir', size: 0, mtimeMs: 1, archived: false },
    { path: 'domini/corsa/_index.md', type: 'file', size: 90, mtimeMs: 1, archived: false },
    {
      path: 'domini/corsa/allenamento-frequenza.md',
      type: 'file',
      size: 200,
      mtimeMs: 1,
      archived: false,
    },
    { path: 'domini/corsa/registro-km.csv', type: 'file', size: 80, mtimeMs: 1, archived: false },
    { path: 'Foglia Semplice.md', type: 'file', size: 45, mtimeMs: 1, archived: false },
    { path: 'allegati', type: 'dir', size: 0, mtimeMs: 1, archived: false },
  ];

  const pages: PageIdentity[] = [
    { id: 'p_home', path: '_index.md', icona: '🏠', copertina: '#dbeafe' },
    { id: 'p_domini', path: 'domini/_index.md', virtual: true },
    { id: 'p_corsa', path: 'domini/corsa/_index.md', icona: '🏃' },
    { id: 'p_allen', path: 'domini/corsa/allenamento-frequenza.md' },
    { id: 'p_foglia', path: 'Foglia Semplice.md', icona: '📝' },
  ];

  it('mostra Home in cima, foglie, nodi con figli (senza mai mostrare _index.md) e cartelle prive di _index.md', () => {
    const tree = buildUnifiedPageTree(entries, pages);

    // 1. Home fissata in cima con nome fisso "Home" e icona
    expect(tree[0]).toMatchObject({
      name: 'Home',
      openPath: '_index.md',
      isHome: true,
      icona: '🏠',
      copertina: '#dbeafe',
      children: [],
    });

    // 2. Cartella `domini` senza `_index.md` su disco compare come pagina virtuale
    const dominiNode = tree.find((n) => n.dirPath === 'domini');
    expect(dominiNode).toBeDefined();
    expect(dominiNode!.name).toBe('domini');
    expect(dominiNode!.openPath).toBe('domini/_index.md');
    expect(dominiNode!.isVirtualIndex).toBe(true);
    expect(dominiNode!.children).toHaveLength(1);

    // 3. Nodo `domini/corsa` mostra il nome "corsa", l'icona 🏃 e i suoi figli (MAI `_index.md`)
    const corsaNode = dominiNode!.children[0]!;
    expect(corsaNode.name).toBe('corsa');
    expect(corsaNode.openPath).toBe('domini/corsa/_index.md');
    expect(corsaNode.managePath).toBe('domini/corsa');
    expect(corsaNode.isVirtualIndex).toBe(false);
    expect(corsaNode.icona).toBe('🏃');

    const childNames = corsaNode.children.map((c) => c.name);
    expect(childNames).toContain('allenamento-frequenza');
    expect(childNames).toContain('registro-km.csv');
    expect(childNames).not.toContain('_index');
    expect(childNames).not.toContain('_index.md');

    // 4. Foglia semplice e allegati nascosti
    const foglia = tree.find((n) => n.openPath === 'Foglia Semplice.md');
    expect(foglia).toBeDefined();
    expect(foglia!.name).toBe('Foglia Semplice');
    expect(foglia!.children).toEqual([]);
    expect(tree.some((n) => n.name === 'allegati')).toBe(false);
  });

  it('risolve titolo e icona sia per pagine foglia sia per pagine-nodo e cartelle virtuali', () => {
    expect(getNoteDisplayName('_index.md')).toBe('Home');
    expect(getNoteDisplayName('domini/corsa/_index.md')).toBe('corsa');
    expect(getNoteDisplayName('domini/corsa/_index.md', { 'domini/corsa': 'Maratona' })).toBe(
      'Maratona',
    );

    const resCorsa = resolveInternalPageTarget('page:p_corsa', '_index.md', entries, pages);
    expect(resCorsa).toEqual({
      id: 'p_corsa',
      path: 'domini/corsa/_index.md',
      displayTitle: 'corsa',
      icona: '🏃',
    });

    const resVirtual = resolveInternalPageTarget('page:p_domini', '_index.md', entries, pages);
    expect(resVirtual).toEqual({
      id: 'p_domini',
      path: 'domini/_index.md',
      displayTitle: 'domini',
    });
  });
});
