import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageIdentity, TreeEntry } from '@brain/shared';
import {
  Archive,
  BotOff,
  ChevronDown,
  ChevronRight,
  Database,
  Edit2,
  FileSpreadsheet,
  FileText,
  Home,
  Moon,
  MoreVertical,
  Plus,
  Star,
  Sun,
  Trash2,
} from 'lucide-react';
import {
  buildUnifiedPageTree,
  sanitizeNoteTitleForFilename,
  type UnifiedPageNode,
} from '../core/pages.js';

export interface TreeProps {
  entries: TreeEntry[];
  pages?: PageIdentity[];
  activePath: string | null;
  favorites: string[];
  showArchived?: boolean;
  hideEmbeddedDatabases?: boolean;
  onToggleHideEmbeddedDatabases?: () => void;
  collapsedFolders?: string[];
  onToggleCollapse?: (folderPath: string) => void;
  onSelectFile: (path: string) => void;
  onCreateFile: () => void;
  onCreateSubpage?: (parentOpenPath: string) => void;
  onMoveIntoPage?: (sourceManagePath: string, targetNode: UnifiedPageNode) => void;
  onRename: (from: string, to: string) => void;
  onArchive?: (path: string) => void;
  onDelete: (path: string) => void;
  onToggleFavorite: (path: string) => void;
  onToggleShowArchived?: () => void;
  selectedTag?: string | null;
  onSelectTag?: (tag: string | null) => void;
  tags?: Array<{ tag: string; count: number }>;
  renamingPath?: string | null;
  onCancelRename?: () => void;
  liveTitleDrafts?: Record<string, string>;
  onLiveTitleDraftChange?: (path: string, draft: string | null) => void;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
  rightPanelOpen?: boolean;
  onToggleRightPanel?: () => void;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  onOpenAlignIds?: () => void;
  linkMetaEnabled?: boolean;
  onToggleLinkMeta?: () => void;
  isGithubMode?: boolean;
  githubRepo?: string;
  onOpenGithubSettings?: () => void;
}

export function Tree({
  entries,
  pages = [],
  activePath,
  favorites,
  showArchived = false,
  hideEmbeddedDatabases = false,
  collapsedFolders,
  onToggleCollapse,
  onSelectFile,
  onCreateFile,
  onCreateSubpage,
  onMoveIntoPage,
  onRename,
  onArchive,
  onDelete,
  onToggleFavorite,
  renamingPath: externalRenamingPath,
  onCancelRename,
  liveTitleDrafts,
  onLiveTitleDraftChange,
  theme,
  onToggleTheme,
  chatOpen,
  onToggleChat,
  isGithubMode,
  githubRepo,
  onOpenGithubSettings,
}: TreeProps) {
  const [filterQuery, setFilterQuery] = useState('');
  const [localCollapsed, setLocalCollapsed] = useState<Set<string>>(new Set());
  const collapsed = useMemo(() => {
    return collapsedFolders ? new Set(collapsedFolders) : localCollapsed;
  }, [collapsedFolders, localCollapsed]);

  const [editingNode, setEditingNode] = useState<UnifiedPageNode | null>(null);
  const [editingName, setEditingName] = useState('');
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [draggedNode, setDraggedNode] = useState<UnifiedPageNode | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const treeNodes = useMemo(
    () =>
      buildUnifiedPageTree(entries, pages, {
        showArchived,
        filterQuery,
        hideEmbeddedDatabases,
        liveTitleDrafts,
      }),
    [entries, pages, showArchived, filterQuery, hideEmbeddedDatabases, liveTitleDrafts],
  );

  // Chiudi il menu a tre puntini se si clicca fuori
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuKey(null);
      }
    };
    if (openMenuKey) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [openMenuKey]);

  // Trova un nodo nell'albero dato openPath o managePath
  const findNodeByPath = (
    nodes: readonly UnifiedPageNode[],
    target: string,
  ): UnifiedPageNode | null => {
    const lower = target.toLowerCase();
    for (const n of nodes) {
      if (
        n.openPath.toLowerCase() === lower ||
        n.managePath.toLowerCase() === lower ||
        (n.dirPath && n.dirPath.toLowerCase() === lower)
      ) {
        return n;
      }
      if (n.children.length > 0) {
        const hit = findNodeByPath(n.children, target);
        if (hit) return hit;
      }
    }
    return null;
  };

  useEffect(() => {
    if (externalRenamingPath) {
      const targetNode = findNodeByPath(treeNodes, externalRenamingPath);
      if (targetNode && !targetNode.isHome) {
        setEditingNode(targetNode);
        setEditingName(targetNode.name);
      }
    }
  }, [externalRenamingPath, treeNodes]);

  useEffect(() => {
    if (editingNode) {
      setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 40);
    }
  }, [editingNode]);

  const toggleCollapse = (dirPath: string) => {
    if (onToggleCollapse) {
      onToggleCollapse(dirPath);
    } else {
      setLocalCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) next.delete(dirPath);
        else next.add(dirPath);
        return next;
      });
    }
  };

  const handleStartRename = (node: UnifiedPageNode) => {
    if (node.isHome) return;
    setOpenMenuKey(null);
    setEditingNode(node);
    setEditingName(node.name);
    onLiveTitleDraftChange?.(node.openPath, node.name);
  };

  const handleCommitRename = () => {
    if (!editingNode) return;
    const node = editingNode;
    const cleaned = sanitizeNoteTitleForFilename(editingName);
    setEditingNode(null);
    onLiveTitleDraftChange?.(node.openPath, null);

    if (!cleaned) {
      onCancelRename?.();
      return;
    }

    if (node.dirPath !== null) {
      // Pagina-nodo: rinomina la cartella, _index.md al suo interno non cambia nome
      const slash = node.dirPath.lastIndexOf('/');
      const parentPrefix = slash >= 0 ? node.dirPath.slice(0, slash + 1) : '';
      const nextDirPath = `${parentPrefix}${cleaned}`;
      if (nextDirPath !== node.dirPath) {
        onRename(node.dirPath, nextDirPath);
      }
    } else {
      // Pagina-foglia
      const slash = node.openPath.lastIndexOf('/');
      const parentPrefix = slash >= 0 ? node.openPath.slice(0, slash + 1) : '';
      const extMatch = node.openPath.match(/\.[^/.]+$/);
      const ext = extMatch ? extMatch[0] : '.md';
      const finalName = cleaned.toLowerCase().endsWith(ext.toLowerCase())
        ? cleaned
        : `${cleaned}${ext}`;
      const nextFilePath = `${parentPrefix}${finalName}`;
      if (nextFilePath !== node.openPath) {
        onRename(node.openPath, nextFilePath);
      }
    }

    onCancelRename?.();
  };

  const handleKeyDownRename = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (editingNode) {
        onLiveTitleDraftChange?.(editingNode.openPath, null);
      }
      setEditingNode(null);
      onCancelRename?.();
    }
  };

  const renderPageIcon = (node: UnifiedPageNode) => {
    if (node.isHome) return <Home size={15} color="var(--accent)" />;
    if (node.tipo === 'database') return <Database size={14} color="#8b5cf6" />;
    if (node.openPath.toLowerCase().endsWith('.csv')) {
      return <FileSpreadsheet size={15} color="#10b981" />;
    }
    if (node.openPath.toLowerCase().endsWith('.txt')) {
      return <FileText size={15} color="#64748b" />;
    }
    return <FileText size={15} color="var(--accent)" />;
  };

  const renderNodeList = (nodes: readonly UnifiedPageNode[], depth = 0) => {
    return nodes.map((node) => {
      const hasChildren = node.children.length > 0;
      const isCollapsed = node.dirPath ? collapsed.has(node.dirPath) : false;
      const isActive =
        activePath !== null &&
        (activePath.toLowerCase() === node.openPath.toLowerCase() ||
          (node.dirPath !== null && activePath.toLowerCase() === node.dirPath.toLowerCase()));
      const isFav =
        favorites.includes(node.openPath) ||
        (node.dirPath !== null && favorites.includes(node.dirPath));
      const isEditing = editingNode?.key === node.key;
      const isMenuOpen = openMenuKey === node.key;
      const isDragging = draggedNode?.key === node.key;
      const isDragOver = dragOverKey === node.key;

      return (
        <div
          key={node.key}
          style={{ position: 'relative' }}
          onDragOver={(e) => {
            if (!draggedNode || !node.isMarkdownPage) return;
            if (draggedNode.key === node.key) return;
            if (
              draggedNode.dirPath &&
              node.dirPath &&
              (node.dirPath === draggedNode.dirPath ||
                node.dirPath.startsWith(`${draggedNode.dirPath}/`))
            ) {
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            if (dragOverKey !== node.key) {
              setDragOverKey(node.key);
            }
          }}
          onDragLeave={(e) => {
            e.stopPropagation();
            if (dragOverKey === node.key) {
              setDragOverKey(null);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOverKey(null);
            if (!draggedNode || draggedNode.key === node.key) return;
            if (onMoveIntoPage) {
              onMoveIntoPage(draggedNode.managePath, node);
            } else if (node.dirPath) {
              const base = draggedNode.managePath.split('/').pop();
              if (base) {
                onRename(draggedNode.managePath, `${node.dirPath}/${base}`);
              }
            }
            setDraggedNode(null);
          }}
        >
          <div
            className={`tree-node ${isActive ? 'active' : ''} ${node.archived ? 'archived' : ''} ${
              isDragging ? 'dragging' : ''
            } ${isDragOver ? 'drag-over' : ''}`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            draggable={!isEditing && !node.isHome}
            onDragStart={(e) => {
              if (node.isHome) {
                e.preventDefault();
                return;
              }
              e.stopPropagation();
              setDraggedNode(node);
              e.dataTransfer.setData('text/plain', node.managePath);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              setDraggedNode(null);
              setDragOverKey(null);
            }}
            onDoubleClick={(e) => {
              if (isEditing || node.isHome) return;
              e.stopPropagation();
              handleStartRename(node);
            }}
            onClick={() => {
              if (isEditing) return;
              onSelectFile(node.openPath);
            }}
          >
            {/* Freccia di espansione: presente solo se la pagina ha figli */}
            <span
              className="tree-chevron-slot"
              style={{
                width: '16px',
                height: '18px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
              onClick={(e) => {
                if (!hasChildren || !node.dirPath) return;
                e.stopPropagation();
                toggleCollapse(node.dirPath);
              }}
              title={hasChildren ? (isCollapsed ? 'Espandi sottopagine' : 'Comprimi sottopagine') : undefined}
            >
              {hasChildren ? (
                isCollapsed ? (
                  <ChevronRight size={13} />
                ) : (
                  <ChevronDown size={13} />
                )
              ) : null}
            </span>

            <span className="tree-icon">{renderPageIcon(node)}</span>

            {isEditing ? (
              <input
                ref={renameInputRef}
                type="text"
                value={editingName}
                onChange={(e) => {
                  const val = e.target.value;
                  setEditingName(val);
                  onLiveTitleDraftChange?.(node.openPath, val);
                }}
                onBlur={handleCommitRename}
                onKeyDown={handleKeyDownRename}
                onClick={(e) => e.stopPropagation()}
                style={{
                  flex: 1,
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--accent)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '1px 4px',
                  fontSize: '13px',
                  outline: 'none',
                  color: 'var(--text-main)',
                }}
              />
            ) : (
              <span className="tree-label" title={node.name}>
                {node.name}
              </span>
            )}

            {isFav && !isEditing && (
              <Star size={11} color="#eab308" fill="#eab308" style={{ flexShrink: 0 }} />
            )}

            {/* Azioni in hover: menu "⋮" */}
            {!isEditing && (
              <div
                className="tree-hover-actions"
                style={{ alignItems: 'center', gap: '2px' }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="sidebar-action-btn"
                  title="Altre opzioni"
                  style={{ padding: '2px', opacity: isMenuOpen ? 1 : undefined }}
                  onClick={() => setOpenMenuKey(isMenuOpen ? null : node.key)}
                >
                  <MoreVertical size={13} />
                </button>
              </div>
            )}
          </div>

          {/* Menu contestuale */}
          {isMenuOpen && (
            <div
              ref={menuRef}
              className="tree-dropdown-menu"
              style={{
                position: 'absolute',
                right: '8px',
                top: '28px',
                zIndex: 60,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {node.isMarkdownPage && onCreateSubpage && (
                <button
                  className="tree-dropdown-item"
                  onClick={() => {
                    setOpenMenuKey(null);
                    onCreateSubpage(node.openPath);
                  }}
                >
                  <Plus size={13} />
                  <span>Aggiungi sottopagina</span>
                </button>
              )}

              <button
                className="tree-dropdown-item"
                onClick={() => {
                  onToggleFavorite(node.openPath);
                  setOpenMenuKey(null);
                }}
              >
                <Star
                  size={13}
                  color={isFav ? '#eab308' : 'var(--text-muted)'}
                  fill={isFav ? '#eab308' : 'none'}
                />
                <span>{isFav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}</span>
              </button>

              {!node.isHome && (
                <>
                  <button
                    className="tree-dropdown-item"
                    onClick={() => handleStartRename(node)}
                  >
                    <Edit2 size={13} />
                    <span>Rinomina</span>
                  </button>

                  {onArchive && !node.archived && (
                    <button
                      className="tree-dropdown-item"
                      onClick={() => {
                        setOpenMenuKey(null);
                        onArchive(node.managePath);
                      }}
                    >
                      <Archive size={13} />
                      <span>Archivia</span>
                    </button>
                  )}

                  <button
                    className="tree-dropdown-item danger"
                    onClick={() => {
                      setOpenMenuKey(null);
                      onDelete(node.managePath);
                    }}
                  >
                    <Trash2 size={13} color="var(--danger, #ef4444)" />
                    <span style={{ color: 'var(--danger, #ef4444)' }}>Elimina definitivamente</span>
                  </button>
                </>
              )}
            </div>
          )}

          {hasChildren && !isCollapsed && renderNodeList(node.children, depth + 1)}
        </div>
      );
    });
  };

  return (
    <aside className="sidebar">
      {/* Barra di ricerca rapida pagine */}
      <div className="sidebar-section">
        <div className="sidebar-search-box">
          <input
            type="text"
            className="sidebar-search-input"
            placeholder="Filtra pagine..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Intestazione unico albero di pagine */}
      <div className="sidebar-actions">
        <span>Pagine</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button className="sidebar-action-btn" title="Nuova pagina" onClick={onCreateFile}>
            <Plus size={14} /> Pagina
          </button>
        </div>
      </div>

      {/* Albero unificato delle pagine */}
      <div
        className={`sidebar-tree-container ${dragOverKey === '__root__' ? 'drag-over-root' : ''}`}
        onDragOver={(e) => {
          if (!draggedNode) return;
          if (!draggedNode.managePath.includes('/')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragOverKey !== '__root__') setDragOverKey('__root__');
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) {
            setDragOverKey(null);
          }
        }}
        onDrop={(e) => {
          if (!draggedNode) return;
          e.preventDefault();
          setDragOverKey(null);
          const srcPath = draggedNode.managePath || e.dataTransfer.getData('text/plain');
          if (!srcPath || !srcPath.includes('/')) return;
          const base = srcPath.split('/').pop();
          if (!base || base === srcPath) return;
          onRename(srcPath, base);
          setDraggedNode(null);
        }}
      >
        {renderNodeList(treeNodes)}
      </div>

      {/* Toolbar inferiore */}
      {(onToggleTheme || onToggleChat) && (
        <div
          className="sidebar-bottom-tools"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--bg-sidebar)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {onToggleTheme && (
              <button
                className="sidebar-action-btn"
                title="Cambia tema chiaro/scuro"
                onClick={onToggleTheme}
              >
                {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
              </button>
            )}
            {isGithubMode && (
              <button
                className="sidebar-action-btn"
                title={`GitHub: ${githubRepo || 'aleg888-tech/second-brain'}. Clicca per impostazioni.`}
                onClick={onOpenGithubSettings}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--text-main)',
                  padding: '3px 8px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-card)',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: '#10b981',
                  }}
                />
                <span>GitHub</span>
              </button>
            )}
          </div>

          {onToggleChat && (
            <button
              className={`sidebar-action-btn ${chatOpen ? 'active' : ''}`}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-muted)' }}
              title="Assistente AI (predisposto, non ancora attivo)"
              onClick={onToggleChat}
            >
              <BotOff size={15} />
              <span style={{ fontSize: '11px', fontWeight: 600 }}>AI: off</span>
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
