import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageIdentity, SearchHit, TreeEntry } from '@brain/shared';
import { FileText, Plus, Search, Sun } from 'lucide-react';
import { api } from '../api/client.js';
import { buildUnifiedPageTree, type UnifiedPageNode } from '../core/pages.js';

export interface CommandPaletteProps {
  isOpen: boolean;
  mode: 'quickOpen' | 'search' | 'commands';
  onClose: () => void;
  entries: TreeEntry[];
  pages?: PageIdentity[];
  onOpenFile: (path: string) => void;
  onCreateFile: () => void;
  onAlignIds?: () => void;
  onToggleTheme: () => void;
}

function flattenTreeNodes(nodes: UnifiedPageNode[], trail: string[] = []): Array<{ node: UnifiedPageNode; breadcrumb: string }> {
  const out: Array<{ node: UnifiedPageNode; breadcrumb: string }> = [];
  for (const n of nodes) {
    const breadcrumb = trail.length > 0 ? `${trail.join(' / ')} / ${n.name}` : n.name;
    out.push({ node: n, breadcrumb });
    if (n.children.length > 0) {
      out.push(...flattenTreeNodes(n.children, [...trail, n.name]));
    }
  }
  return out;
}

export function CommandPalette({
  isOpen,
  mode,
  onClose,
  entries,
  pages = [],
  onOpenFile,
  onCreateFile,
  onAlignIds,
  onToggleTheme,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSearchResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, mode]);

  // Ricerca testuale con debounce
  useEffect(() => {
    if (!isOpen || mode !== 'search' || !query.trim()) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.search(query.trim(), 40);
        setSearchResults(res.hits);
        setSelectedIndex(0);
      } catch {
        setSearchResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [query, isOpen, mode]);

  const allPages = useMemo(() => {
    const tree = buildUnifiedPageTree(entries, pages, { showArchived: false });
    return flattenTreeNodes(tree);
  }, [entries, pages]);

  if (!isOpen) return null;

  // Risultati per Quick Open (Ctrl+O)
  const qLower = query.trim().toLowerCase();
  const filteredFiles = allPages
    .filter(
      (item) =>
        !qLower ||
        item.node.name.toLowerCase().includes(qLower) ||
        item.breadcrumb.toLowerCase().includes(qLower) ||
        item.node.openPath.toLowerCase().includes(qLower),
    )
    .slice(0, 30);

  // Comandi della palette (Ctrl+Shift+P)
  const commandList = [
    { id: 'new_note', label: 'Crea nuova pagina', icon: <Plus size={16} />, action: onCreateFile },
    ...(onAlignIds
      ? [
          {
            id: 'align_ids',
            label: 'Allinea id nel frontmatter (con anteprima)',
            icon: <FileText size={16} />,
            action: onAlignIds,
          },
        ]
      : []),
    { id: 'toggle_theme', label: 'Inverti tema chiaro / scuro', icon: <Sun size={16} />, action: onToggleTheme },
  ].filter((c) => !qLower || c.label.toLowerCase().includes(qLower));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }

    const maxItems =
      mode === 'quickOpen' ? filteredFiles.length : mode === 'search' ? searchResults.length : commandList.length;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, maxItems));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + maxItems) % Math.max(1, maxItems));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (mode === 'quickOpen' && filteredFiles[selectedIndex]) {
        onOpenFile(filteredFiles[selectedIndex]!.node.openPath);
        onClose();
      } else if (mode === 'search' && searchResults[selectedIndex]) {
        onOpenFile(searchResults[selectedIndex]!.path);
        onClose();
      } else if (mode === 'commands' && commandList[selectedIndex]) {
        commandList[selectedIndex]!.action();
        onClose();
      }
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="modal-search-input"
          placeholder={
            mode === 'quickOpen'
              ? 'Apertura rapida nota (Ctrl+O)...'
              : mode === 'search'
              ? 'Cerca testo in tutta la knowledge base...'
              : 'Esegui comando...'
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />

        <div className="modal-results-list">
          {mode === 'quickOpen' &&
            (filteredFiles.length === 0 ? (
              <div style={{ padding: '16px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '13px' }}>
                Nessun file trovato.
              </div>
            ) : (
              filteredFiles.map((item, i) => (
                <div
                  key={item.node.key}
                  className={`modal-result-item ${selectedIndex === i ? 'selected' : ''}`}
                  onClick={() => {
                    onOpenFile(item.node.openPath);
                    onClose();
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {item.node.icona ? (
                      <span style={{ fontSize: '14px' }}>{item.node.icona}</span>
                    ) : (
                      <FileText size={15} color="var(--accent)" />
                    )}
                    <span>{item.breadcrumb}</span>
                  </div>
                  {item.node.archived && (
                    <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>Archiviato</span>
                  )}
                </div>
              ))
            ))}

          {mode === 'search' &&
            (loading ? (
              <div style={{ padding: '16px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '13px' }}>
                Ricerca in corso...
              </div>
            ) : searchResults.length === 0 ? (
              <div style={{ padding: '16px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '13px' }}>
                {query.trim() ? 'Nessun risultato trovato.' : 'Digita per cercare nel testo.'}
              </div>
            ) : (
              searchResults.map((h, i) => (
                <div
                  key={`${h.path}-${h.line}-${i}`}
                  className={`modal-result-item ${selectedIndex === i ? 'selected' : ''}`}
                  onClick={() => {
                    onOpenFile(h.path);
                    onClose();
                  }}
                  style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                    <Search size={13} color="var(--accent)" />
                    <span>{h.path}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>riga {h.line}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>{h.preview}</div>
                </div>
              ))
            ))}

          {mode === 'commands' &&
            commandList.map((c, i) => (
              <div
                key={c.id}
                className={`modal-result-item ${selectedIndex === i ? 'selected' : ''}`}
                onClick={() => {
                  c.action();
                  onClose();
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {c.icon}
                  <span>{c.label}</span>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
