import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConfigResponse,
  HistoryEntry,
  LinksResponse,
  PageIdentity,
  PropertyDefinition,
  TagInfo,
  TreeEntry,
} from '@brain/shared';
import {
  AlertTriangle,
  FileCode,
  KeyRound,
  Save,
} from 'lucide-react';
import { api } from './api/client.js';
import { ChatPanel } from './components/ChatPanel.js';
import { CommandPalette } from './components/CommandPalette.js';
import { Editor } from './components/Editor.js';
import { HistoryModal } from './components/HistoryModal.js';
import { Preview } from './components/Preview.js';
import { PropertiesPanel } from './components/PropertiesPanel.js';
import { TableViewWidget } from './components/TableViewWidget.js';
import { Tree } from './components/Tree.js';
import { parseFrontmatter, patchFrontmatterInMemory } from './core/frontmatter.js';
import {
  getNoteDisplayName,
  isHomePage,
  isNodeIndexPath,
  nodeDirOfPagePath,
  purgeMissingInternalLinksFromMarkdown,
  resolveInternalPageTarget,
  type UnifiedPageNode,
} from './core/pages.js';

interface OpenTab {
  path: string;
  content: string;
  baseVersion: string;
  dirty: boolean;
}

export function App() {
  const [tokenInput, setTokenInput] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(api.hasToken());

  // Supporto modalità online GitHub
  const isGithubMode = api.isGithubMode();
  const initialGhConfig = api.github.getConfig();
  const [ghOwner, setGhOwner] = useState(initialGhConfig.owner || 'aleg888-tech');
  const [ghRepo, setGhRepo] = useState(initialGhConfig.repo || 'second-brain');
  const [ghBranch, setGhBranch] = useState(initialGhConfig.branch || 'main');
  const [ghFolder, setGhFolder] = useState(initialGhConfig.percorsoKb || 'kb');
  const [ghToken, setGhToken] = useState(initialGhConfig.token || '');
  const [authError, setAuthError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [githubSettingsOpen, setGithubSettingsOpen] = useState(false);

  const handleGithubConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ghToken.trim()) {
      setAuthError('Inserisci un GitHub Personal Access Token.');
      return;
    }
    setIsValidating(true);
    setAuthError(null);
    try {
      api.github.setConfig({
        owner: ghOwner.trim() || 'aleg888-tech',
        repo: ghRepo.trim() || 'second-brain',
        branch: ghBranch.trim() || 'main',
        percorsoKb: ghFolder.trim() || 'kb',
        token: ghToken.trim(),
      });
      const check = await api.github.validateConnection();
      if (!check.success) {
        setAuthError(check.error || 'Impossibile connettersi al repository.');
        setIsValidating(false);
        return;
      }
      setIsAuthenticated(true);
    } catch (err: any) {
      setAuthError(err.message || 'Errore di connessione a GitHub.');
    } finally {
      setIsValidating(false);
    }
  };

  // Stato dati dell'applicazione
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([]);
  const [pages, setPages] = useState<PageIdentity[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [liveTitleDrafts, setLiveTitleDrafts] = useState<Record<string, string>>({});
  const [autoFocusTitlePath, setAutoFocusTitlePath] = useState<string | null>(null);

  // Stato schede e visualizzazione
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [favorites, setFavorites] = useState<string[]>(['_index.md']);
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState<boolean>(false);
  const [rightPanelOpen, setRightPanelOpen] = useState<boolean>(true);
  const [chatOpen, setChatOpen] = useState<boolean>(false);

  // Stato ispettore per il file attivo
  const [_currentLinks, setCurrentLinks] = useState<LinksResponse | null>(null);
  const [_currentHistory, setCurrentHistory] = useState<HistoryEntry[]>([]);
  const [externalConflict, setExternalConflict] = useState<string | null>(null);

  // Modali e Palette
  const [paletteMode, setPaletteMode] = useState<'quickOpen' | 'search' | 'commands' | null>(null);
  const [historyModalVersionId, setHistoryModalVersionId] = useState<string | null>(null);
  const [historyModalContent, setHistoryModalContent] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  const lastSignatureRef = useRef<string>('');
  const initialLoadDoneRef = useRef(false);

  const treeEntriesRef = useRef(treeEntries);
  treeEntriesRef.current = treeEntries;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;
  const collapsedFoldersRef = useRef(collapsedFolders);
  collapsedFoldersRef.current = collapsedFolders;
  const renamedPathMapRef = useRef<Map<string, string>>(new Map());
  const renameQueueRef = useRef<Promise<void>>(Promise.resolve());

  const refreshTreeAndPages = useCallback(async (includeArchived: boolean) => {
    const data = await api.getTreeWithPages(includeArchived);
    setTreeEntries(data.entries);
    setPages(data.pages ?? []);
    return data;
  }, []);

  const handleLiveTitleDraftChange = useCallback((targetPath: string, draft: string | null) => {
    setLiveTitleDrafts((prev) => {
      if (draft === null) {
        if (!Object.prototype.hasOwnProperty.call(prev, targetPath)) return prev;
        const next = { ...prev };
        delete next[targetPath];
        return next;
      }
      if (prev[targetPath] === draft) return prev;
      return { ...prev, [targetPath]: draft };
    });
  }, []);

  // Salvataggio preferenze di vista persistente (.brain/vista.json) con debouncing
  const persistVistaTimerRef = useRef<any>(null);
  const persistVista = useCallback((patch: Partial<import('@brain/shared').Vista>) => {
    if (persistVistaTimerRef.current) {
      clearTimeout(persistVistaTimerRef.current);
    }
    persistVistaTimerRef.current = setTimeout(() => {
      api.updateVista(patch).catch((err) => {
        console.warn('[App] Errore salvataggio preferenze vista:', err);
      });
    }, 250);
  }, []);

  // 1. Inizializzazione tema
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // 2. Caricamento iniziale dei dati e ripristino esatto della sessione precedente
  const loadInitialData = useCallback(async () => {
    try {
      const vista = await api.getVista().catch(() => null);
      const initialShowArchived = vista?.showArchived ?? false;
      const initialCollapsed = vista?.collapsed || [];
      const initialFavorites = vista?.favorites || ['_index.md'];
      const initialRightPanel = vista?.rightPanelOpen ?? true;
      const initialTheme = vista?.theme === 'light' || vista?.theme === 'dark' ? vista.theme : 'dark';

      setShowArchived(initialShowArchived);
      setCollapsedFolders(initialCollapsed);
      setFavorites(initialFavorites);
      setRightPanelOpen(initialRightPanel);
      setTheme(initialTheme);

      const [conf, treeData, tagList] = await Promise.all([
        api.getConfig(),
        api.getTreeWithPages(initialShowArchived),
        api.getTags(),
      ]);

      setConfig(conf);
      setTreeEntries(treeData.entries);
      setPages(treeData.pages ?? []);
      setTags(tagList);

      // Ripristino delle schede e della nota attiva dall'ultima sessione
      if (!initialLoadDoneRef.current) {
        initialLoadDoneRef.current = true;
        const savedTabs = vista?.openTabs && vista.openTabs.length > 0 ? vista.openTabs : ['_index.md'];
        const targetActive = vista?.activePath || savedTabs[0];

        const restoredTabs: OpenTab[] = [];
        for (const p of savedTabs) {
          try {
            const file = await api.getFile(p);
            restoredTabs.push({
              path: file.path,
              content: file.content,
              baseVersion: file.version,
              dirty: false,
            });
          } catch {
            // File non più presente su disco: saltalo
          }
        }

        if (restoredTabs.length > 0) {
          setTabs(restoredTabs);
          const hasTarget = restoredTabs.some((t) => t.path === targetActive);
          const finalActive = hasTarget ? targetActive : restoredTabs[0].path;
          setActivePath(finalActive);
          loadMetadata(finalActive);
        } else if (treeData.entries.some((e) => e.path === '_index.md')) {
          openFile('_index.md');
        }
      }
    } catch (err) {
      console.error('[App] Errore durante il caricamento iniziale:', err);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      loadInitialData();
    }
  }, [isAuthenticated, loadInitialData]);

  // 3. Polling per rilevare modifiche esterne (ogni 2s in locale, ogni 20s su GitHub per i rate-limit)
  useEffect(() => {
    if (!isAuthenticated) return;

    const pollInterval = isGithubMode ? 20000 : 2000;
    const interval = setInterval(async () => {
      try {
        const status = await api.getStatus();
        if (lastSignatureRef.current && status.signature !== lastSignatureRef.current) {
          // L'albero o i file sono cambiati su disco
          const [updatedTreeData, updatedTags] = await Promise.all([
            api.getTreeWithPages(showArchived),
            api.getTags(),
          ]);
          setTreeEntries(updatedTreeData.entries);
          setPages(updatedTreeData.pages ?? []);
          setTags(updatedTags);

          // Verifica se il file attualmente aperto è cambiato all'esterno
          if (activePath) {
            const currentTab = tabs.find((t) => t.path === activePath);
            if (currentTab) {
              try {
                const fresh = await api.getFile(activePath);
                if (fresh.version !== currentTab.baseVersion) {
                  if (!currentTab.dirty) {
                    // Non ci sono modifiche non salvate: aggiorna automaticamente
                    setTabs((prev) =>
                      prev.map((t) =>
                        t.path === activePath
                          ? { ...t, content: fresh.content, baseVersion: fresh.version }
                          : t,
                      ),
                    );
                    setExternalConflict(null);
                  } else {
                    setExternalConflict(activePath);
                  }
                }
              } catch {
                // Il file potrebbe essere stato spostato o archiviato
              }
            }
          }
        }
        lastSignatureRef.current = status.signature;
      } catch {
        // Ignora errori transitori di polling
      }
    }, pollInterval);

    return () => clearInterval(interval);
  }, [isAuthenticated, showArchived, activePath, tabs, isGithubMode]);

  // 4. Apertura di un file
  const openFile = async (path: string) => {
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      setActivePath(path);
      loadMetadata(path);
      persistVista({ activePath: path });
      return;
    }

    try {
      const file = await api.getFile(path);
      const newTab: OpenTab = {
        path: file.path,
        content: file.content,
        baseVersion: file.version,
        dirty: false,
      };
      const nextTabs = [...tabs, newTab];
      setTabs(nextTabs);
      setActivePath(file.path);
      loadMetadata(file.path);
      setExternalConflict(null);
      persistVista({
        openTabs: nextTabs.map((t) => t.path),
        activePath: file.path,
      });
    } catch (err: unknown) {
      alert(`Impossibile aprire "${path}": ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Caricamento metadati per la nota attiva (link, backlink, storico)
  const loadMetadata = async (path: string) => {
    if (!path.endsWith('.md')) {
      setCurrentLinks(null);
      setCurrentHistory([]);
      return;
    }
    try {
      const [links, hist] = await Promise.all([
        api.getLinks(path).catch(() => null),
        api.getHistory(path).catch(() => []),
      ]);
      setCurrentLinks(links);
      setCurrentHistory(hist);
    } catch {
      // ignore
    }
  };

  const closeTab = (path: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const tabToClose = tabs.find((t) => t.path === path);
    if (tabToClose?.dirty) {
      const confirmClose = window.confirm(`"${path}" contiene modifiche non salvate. Chiudere comunque?`);
      if (!confirmClose) return;
    }

    const nextTabs = tabs.filter((t) => t.path !== path);
    setTabs(nextTabs);

    let nextActive: string | null = null;
    if (activePath === path) {
      nextActive = nextTabs.length > 0 ? nextTabs[nextTabs.length - 1]!.path : null;
      setActivePath(nextActive);
      if (nextActive) loadMetadata(nextActive);
      else {
        setCurrentLinks(null);
        setCurrentHistory([]);
      }
    } else {
      nextActive = activePath;
    }

    persistVista({
      openTabs: nextTabs.map((t) => t.path),
      activePath: nextActive,
    });
  };

  const handleToggleCollapse = (folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = prev.includes(folderPath) ? prev.filter((p) => p !== folderPath) : [...prev, folderPath];
      persistVista({ collapsed: next });
      return next;
    });
  };

  const handleToggleShowArchived = () => {
    const nextVal = !showArchived;
    setShowArchived(nextVal);
    persistVista({ showArchived: nextVal });
    void refreshTreeAndPages(nextVal);
  };

  const handleToggleFavorite = (favPath: string) => {
    setFavorites((prev) => {
      const next = prev.includes(favPath) ? prev.filter((p) => p !== favPath) : [...prev, favPath];
      persistVista({ favorites: next });
      return next;
    });
  };

  const handleToggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    persistVista({ theme: nextTheme });
  };

  const handleToggleRightPanel = () => {
    const next = !rightPanelOpen;
    setRightPanelOpen(next);
    persistVista({ rightPanelOpen: next });
  };

  // 5. Salvataggio file attivo
  const handleSaveActiveFile = async () => {
    const currentTab = tabs.find((t) => t.path === activePath);
    if (!currentTab || !currentTab.dirty) return;

    try {
      const res = await api.saveFile(currentTab.path, currentTab.content, currentTab.baseVersion);
      setTabs((prev) =>
        prev.map((t) =>
          t.path === currentTab.path
            ? { ...t, baseVersion: res.file.version, dirty: false }
            : t,
        ),
      );
      setExternalConflict(null);
      loadMetadata(currentTab.path);
    } catch (err: unknown) {
      const e = err as { code?: string; status?: number; current?: any };
      if (e.code === 'conflict' || e.status === 409) {
        setExternalConflict(currentTab.path);
        alert(
          'Conflitto di versione (409): il file è stato modificato su disco da un altro programma. Usa il banner in alto per risolvere il conflitto.',
        );
      } else {
        alert(`Errore durante il salvataggio: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // Aggiorna in modo atomico schede aperte, scheda attiva, preferiti e nodi espansi dopo conversione o rinomina
  const remapClientPaths = useCallback(
    (
      mapPath: (p: string) => string,
      extraExpandDirs: readonly string[] = [],
    ) => {
      const nextTabs = tabsRef.current.map((t) => ({
        ...t,
        path: mapPath(t.path),
      }));
      tabsRef.current = nextTabs;
      setTabs(nextTabs);

      const curActive = activePathRef.current;
      const nextActive = curActive ? mapPath(curActive) : null;
      if (nextActive !== curActive) {
        activePathRef.current = nextActive;
        setActivePath(nextActive);
      }

      const nextFavs = Array.from(new Set(favoritesRef.current.map(mapPath)));
      favoritesRef.current = nextFavs;
      setFavorites(nextFavs);

      const expandLower = new Set(extraExpandDirs.map((d) => d.toLowerCase()));
      const nextCollapsed = collapsedFoldersRef.current
        .map(mapPath)
        .filter((d) => !expandLower.has(d.toLowerCase()));
      collapsedFoldersRef.current = nextCollapsed;
      setCollapsedFolders(nextCollapsed);

      setLiveTitleDrafts((prev) => {
        const next: Record<string, string> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          const mapped = mapPath(k);
          next[mapped] = v;
          if (mapped !== k) changed = true;
        }
        return changed ? next : prev;
      });

      persistVista({
        openTabs: nextTabs.map((t) => t.path),
        activePath: nextActive,
        favorites: nextFavs,
        collapsed: nextCollapsed,
      });
    },
    [persistVista],
  );

  // Patch chirurgica di un singolo campo del frontmatter per la nota attiva
  const handlePatchActiveFrontmatter = async (
    key: string,
    value: unknown,
    unset = false,
  ) => {
    const currentTab = tabsRef.current.find((t) => t.path === activePathRef.current);
    if (!currentTab) return;

    try {
      if (!currentTab.dirty) {
        const res = await api.patchFrontmatter(
          currentTab.path,
          key,
          value,
          currentTab.baseVersion,
          unset,
        );
        setTabs((prev) =>
          prev.map((t) =>
            t.path === currentTab.path
              ? { ...t, content: res.content, baseVersion: res.file.version, dirty: false }
              : t,
          ),
        );
      } else {
        const nextContent = patchFrontmatterInMemory(currentTab.content, key, value, unset);
        const saved = await api.saveFile(currentTab.path, nextContent, currentTab.baseVersion);
        setTabs((prev) =>
          prev.map((t) =>
            t.path === currentTab.path
              ? { ...t, content: nextContent, baseVersion: saved.file.version, dirty: false }
              : t,
          ),
        );
      }
      setExternalConflict(null);
      await refreshTreeAndPages(showArchived);
      void loadMetadata(currentTab.path);
    } catch (err: unknown) {
      const e = err as { code?: string; status?: number };
      if (e.code === 'conflict' || e.status === 409) {
        setExternalConflict(currentTab.path);
        alert(
          'Conflitto di versione (409): il file è stato modificato su disco da un altro programma.',
        );
      } else {
        alert(
          `Errore modifica proprietà "${key}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  // Creazione nuova pagina dalla sidebar (crea subito e avvia rinomina sincronizzata)
  const handleCreateFile = async () => {
    try {
      const res = await api.createSubpage('_index.md');
      const createdPath = res.created.file.path;
      await refreshTreeAndPages(showArchived);
      await openFile(createdPath);
      setRenamingPath(createdPath);
    } catch (err: unknown) {
      alert(`Errore creazione pagina: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // "Aggiungi sottopagina" dalla sidebar (converte atomicamente foglia -> nodo se necessario e inserisce il link in fondo alla pagina madre)
  const handleAddSubpageFromTree = async (parentOpenPath: string) => {
    try {
      const openParent = tabsRef.current.find(
        (t) => t.path.toLowerCase() === parentOpenPath.toLowerCase(),
      );
      if (openParent?.dirty) {
        const saved = await api.saveFile(
          openParent.path,
          openParent.content,
          openParent.baseVersion,
        );
        setTabs((prev) =>
          prev.map((t) =>
            t.path === openParent.path
              ? { ...t, baseVersion: saved.file.version, dirty: false }
              : t,
          ),
        );
      }

      const res = await api.createSubpage(parentOpenPath);
      let effectiveParentPath = parentOpenPath;
      if (res.convertedParent) {
        const { from, to } = res.convertedParent;
        renamedPathMapRef.current.set(from, to);
        effectiveParentPath = to;
        const convertedDir = nodeDirOfPagePath(to);
        remapClientPaths(
          (p) => (p.toLowerCase() === from.toLowerCase() ? to : p),
          convertedDir ? [convertedDir] : [],
        );
      } else {
        const existingDir = nodeDirOfPagePath(parentOpenPath);
        if (existingDir) {
          remapClientPaths((p) => p, [existingDir]);
        }
      }

      // Inserisce il link [[page:...]] alla nuova sottopagina alla fine della pagina madre
      const childPageId = res.created.pageId;
      const childPath = res.created.file.path;
      const linkToken = childPageId ? `[[page:${childPageId}]]` : `[[${childPath}]]`;

      try {
        const parentFile = await api.getFile(effectiveParentPath);
        const parentContent = parentFile.content;
        const eol = parentContent.includes('\r\n') ? '\r\n' : '\n';
        let updatedParentContent: string;
        if (parentContent.trim() === '') {
          updatedParentContent = `${linkToken}${eol}`;
        } else if (parentContent.endsWith('\n')) {
          updatedParentContent = `${parentContent}${linkToken}${eol}`;
        } else {
          updatedParentContent = `${parentContent}${eol}${eol}${linkToken}${eol}`;
        }

        const savedParent = await api.saveFile(
          effectiveParentPath,
          updatedParentContent,
          parentFile.version,
        );

        setTabs((prev) =>
          prev.map((t) =>
            t.path.toLowerCase() === effectiveParentPath.toLowerCase()
              ? {
                  ...t,
                  path: effectiveParentPath,
                  content: updatedParentContent,
                  baseVersion: savedParent.file.version,
                  dirty: false,
                }
              : t,
          ),
        );
      } catch (err) {
        console.warn('[App] Errore inserimento link sottopagina nella pagina madre:', err);
      }

      await refreshTreeAndPages(showArchived);
      await openFile(childPath);
      setRenamingPath(childPath);
    } catch (err: unknown) {
      alert(`Errore creazione sottopagina: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Creazione immediata di una sottopagina collegata tramite comando "/" nel testo della nota
  const handleCreateSubpageFromSlash = async (
    replaceSlashWithToken: (token: string) => string,
    initialTitle?: string,
  ) => {
    const parentTab = tabsRef.current.find((t) => t.path === activePathRef.current);
    if (!parentTab) return;
    let effectiveParentPath = parentTab.path;
    let effectiveParentVersion = parentTab.baseVersion;

    try {
      // Se la nota padre ha modifiche non ancora su disco e sta per essere convertita in nodo, salvala prima
      if (parentTab.dirty && !isHomePage(effectiveParentPath) && !isNodeIndexPath(effectiveParentPath)) {
        const preSaved = await api.saveFile(
          effectiveParentPath,
          parentTab.content,
          effectiveParentVersion,
        );
        effectiveParentVersion = preSaved.file.version;
      }

      // 1. Crea la sottopagina (convertendo atomicamente la pagina corrente in nodo se necessario)
      const sub = await api.createSubpage(effectiveParentPath, initialTitle);
      if (sub.convertedParent) {
        const { from, to } = sub.convertedParent;
        renamedPathMapRef.current.set(from, to);
        effectiveParentPath = to;
        const freshParent = await api.getFile(to);
        effectiveParentVersion = freshParent.version;
        const convertedDir = nodeDirOfPagePath(to);
        remapClientPaths(
          (p) => (p.toLowerCase() === from.toLowerCase() ? to : p),
          convertedDir ? [convertedDir] : [],
        );
      }

      await refreshTreeAndPages(showArchived);

      // 2. Inserisce il collegamento immutabile [[page:<id>]] nel testo della nota corrente
      const token = sub.created.pageId
        ? `[[page:${sub.created.pageId}]]`
        : `[[${sub.created.file.path}]]`;
      const updatedParentContent = replaceSlashWithToken(token);

      // 3. Salva la nota corrente su disco mantenendo l'utente sulla nota corrente (senza aprirla di default)
      let nextParentVersion = effectiveParentVersion;
      let parentStillDirty = false;
      try {
        const savedParent = await api.saveFile(
          effectiveParentPath,
          updatedParentContent,
          effectiveParentVersion,
        );
        nextParentVersion = savedParent.file.version;
      } catch {
        parentStillDirty = true;
      }

      setTabs((prev) =>
        prev.map((t) =>
          t.path.toLowerCase() === effectiveParentPath.toLowerCase()
            ? {
                ...t,
                path: effectiveParentPath,
                content: updatedParentContent,
                baseVersion: nextParentVersion,
                dirty: parentStillDirty,
              }
            : t,
        ),
      );

      return { pageId: sub.created.pageId, path: sub.created.file.path };
    } catch (err: unknown) {
      alert(`Errore creazione pagina: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Drag & Drop di una pagina sopra un'altra pagina nella sidebar (converte il bersaglio in nodo se è una foglia)
  const handleMoveIntoPage = async (sourceManagePath: string, targetNode: UnifiedPageNode) => {
    try {
      let targetDir = '';
      if (targetNode.isHome) {
        targetDir = '';
      } else if (targetNode.dirPath) {
        targetDir = targetNode.dirPath;
      } else if (targetNode.isMarkdownPage) {
        const conv = await api.convertLeafToNode(targetNode.openPath);
        renamedPathMapRef.current.set(conv.from, conv.to);
        targetDir = conv.to.slice(0, -'/_index.md'.length);
        remapClientPaths(
          (p) => (p.toLowerCase() === conv.from.toLowerCase() ? conv.to : p),
          [targetDir],
        );
      } else {
        return;
      }

      const base = sourceManagePath.split('/').pop() ?? sourceManagePath;
      const dest = targetDir ? `${targetDir}/${base}` : base;
      handleRename(sourceManagePath, dest);
    } catch (err: unknown) {
      alert(`Impossibile spostare la pagina: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const resolveLatestPath = (p: string): string => {
    let cur = p;
    const visited = new Set<string>();
    while (renamedPathMapRef.current.has(cur) && !visited.has(cur)) {
      visited.add(cur);
      cur = renamedPathMapRef.current.get(cur)!;
    }
    return cur;
  };

  // Rinomina o sposta serializzata (vale sia per foglie sia per pagine-nodo, gestendo collisioni e maiuscole/minuscole)
  const handleRename = (
    fromPath: string,
    toPath: string,
    options?: { silentOnConflict?: boolean },
  ) => {
    renameQueueRef.current = renameQueueRef.current.then(async () => {
      const actualFrom = resolveLatestPath(fromPath);
      let actualTo = toPath;
      if (actualFrom !== fromPath) {
        const toName = toPath.split('/').pop() ?? toPath;
        const actualSlash = actualFrom.lastIndexOf('/');
        const actualDir = actualSlash >= 0 ? actualFrom.slice(0, actualSlash + 1) : '';
        actualTo = `${actualDir}${toName}`;
      }
      if (!actualTo || actualFrom === actualTo) return;

      const sameIgnoringCase = actualFrom.toLowerCase() === actualTo.toLowerCase();
      if (!sameIgnoringCase) {
        const toLower = actualTo.toLowerCase();
        const stemLower = toLower.endsWith('.md') ? toLower.slice(0, -3) : toLower;
        const conflictExists = treeEntriesRef.current.some((e) => {
          const el = e.path.toLowerCase();
          return el === toLower || el === stemLower || el === `${stemLower}.md`;
        });
        if (conflictExists) {
          if (options?.silentOnConflict) return;
          alert(`Esiste già una pagina con il nome "${getNoteDisplayName(actualTo)}".`);
          return;
        }
      }

      try {
        const res = await api.rename(actualFrom, actualTo);
        renamedPathMapRef.current.set(actualFrom, res.to);

        const fromLower = res.from.toLowerCase();
        const isDirMove = !res.from.includes('.') && !res.to.includes('.');
        remapClientPaths((p) => {
          const pl = p.toLowerCase();
          if (pl === fromLower) return res.to;
          if (isDirMove && pl.startsWith(`${fromLower}/`)) {
            return `${res.to}${p.slice(res.from.length)}`;
          }
          return p;
        });

        await refreshTreeAndPages(showArchived);
      } catch (err: unknown) {
        if (!options?.silentOnConflict) {
          alert(`Errore rinomina: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
  };

  // Allinea le schede aperte dopo l'eliminazione/archiviazione di una pagina (rimuovendo i link interni ora orfani)
  const syncOpenTabsAfterPageRemoval = async (
    removedPath: string,
    freshEntries: readonly TreeEntry[],
    freshPages: readonly PageIdentity[],
  ) => {
    const remainingTabs = tabsRef.current.filter((t) => t.path !== removedPath);
    if (remainingTabs.length === 0) return;

    const refreshedByPath = new Map<string, { content: string; version: string }>();
    await Promise.all(
      remainingTabs
        .filter((t) => t.path.toLowerCase().endsWith('.md'))
        .map(async (t) => {
          try {
            const fresh = await api.getFile(t.path);
            refreshedByPath.set(t.path, { content: fresh.content, version: fresh.version });
          } catch {
            // ignore
          }
        }),
    );

    setTabs((prev) =>
      prev.map((t) => {
        if (!t.path.toLowerCase().endsWith('.md')) return t;
        const disk = refreshedByPath.get(t.path);
        if (!t.dirty && disk) {
          return { ...t, content: disk.content, baseVersion: disk.version };
        }
        const purged = purgeMissingInternalLinksFromMarkdown(
          t.content,
          t.path,
          freshEntries,
          freshPages,
        );
        return {
          ...t,
          content: purged,
          baseVersion: disk ? disk.version : t.baseVersion,
        };
      }),
    );
  };

  const closeMatchingTabs = (removedPath: string) => {
    const lower = removedPath.toLowerCase();
    const nextTabs = tabsRef.current.filter((t) => {
      const tl = t.path.toLowerCase();
      return tl !== lower && !tl.startsWith(`${lower}/`);
    });
    tabsRef.current = nextTabs;
    setTabs(nextTabs);

    const curActive = activePathRef.current;
    if (
      curActive &&
      (curActive.toLowerCase() === lower || curActive.toLowerCase().startsWith(`${lower}/`))
    ) {
      const nextActive = nextTabs.length > 0 ? nextTabs[nextTabs.length - 1]!.path : null;
      activePathRef.current = nextActive;
      setActivePath(nextActive);
      if (nextActive) void loadMetadata(nextActive);
      else {
        setCurrentLinks(null);
        setCurrentHistory([]);
      }
      persistVista({ openTabs: nextTabs.map((t) => t.path), activePath: nextActive });
    } else {
      persistVista({ openTabs: nextTabs.map((t) => t.path), activePath: curActive });
    }
  };

  // Archiviazione pagina (foglia o nodo)
  const handleArchive = async (path: string) => {
    if (isHomePage(path)) return;
    const confirm = window.confirm(`Sei sicuro di voler archiviare "${getNoteDisplayName(path)}" in _archivio/?`);
    if (!confirm) return;

    try {
      await api.archive(path);
      closeMatchingTabs(path);
      const treeData = await refreshTreeAndPages(showArchived);
      await syncOpenTabsAfterPageRemoval(path, treeData.entries, treeData.pages ?? []);
    } catch (err: unknown) {
      alert(`Errore archiviazione: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Eliminazione definitiva pagina (foglia o nodo)
  const handleDeleteFile = async (path: string) => {
    if (isHomePage(path)) return;
    const confirmDelete = window.confirm(
      `Sei sicuro di voler eliminare DEFINITIVAMENTE "${getNoteDisplayName(path)}"? L'operazione non può essere annullata.`,
    );
    if (!confirmDelete) return;

    try {
      await api.deleteFile(path);
      closeMatchingTabs(path);
      const treeData = await refreshTreeAndPages(showArchived);
      await syncOpenTabsAfterPageRemoval(path, treeData.entries, treeData.pages ?? []);
    } catch (err: unknown) {
      alert(`Errore eliminazione: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Ripristino versione storica
  const handleRestoreVersion = async (versionId: string) => {
    if (!activePath) return;
    const confirm = window.confirm(`Ripristinare lo snapshot "${versionId}"? La versione attuale verrà salvata nello storico.`);
    if (!confirm) return;

    try {
      await api.restoreHistory(activePath, versionId);
      const fresh = await api.getFile(activePath);
      setTabs((prev) =>
        prev.map((t) =>
          t.path === activePath
            ? { ...t, content: fresh.content, baseVersion: fresh.version, dirty: false }
            : t,
        ),
      );
      void loadMetadata(activePath);
      setHistoryModalVersionId(null);
    } catch (err: unknown) {
      alert(`Errore ripristino: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Anteprima versione storica in modale
  const _handlePreviewVersion = async (versionId: string) => {
    void _handlePreviewVersion;
    if (!activePath) return;
    try {
      const res = await api.getHistoryVersion(activePath, versionId);
      setHistoryModalVersionId(versionId);
      setHistoryModalContent(res.content);
    } catch (err: unknown) {
      alert(`Errore caricamento versione: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Gestione scorciatoie tastiera globali
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setPaletteMode('quickOpen');
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setPaletteMode('search');
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPaletteMode('commands');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSaveActiveFile();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        if (activePath) closeTab(activePath);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const activeTab = tabs.find((t) => t.path === activePath);
  const availableNotePaths = treeEntries.filter((e) => e.type === 'file').map((e) => e.path);

  const parsedActiveDoc = useMemo(() => {
    if (!activeTab) return null;
    return parseFrontmatter(activeTab.content);
  }, [activeTab?.content, activeTab?.path]);

  const [activeParentDbSchema, setActiveParentDbSchema] = useState<PropertyDefinition[] | null>(
    null,
  );

  // Rileva se la pagina aperta è una riga figlia diretta di un database per mostrare lo schema nel pannello proprietà
  useEffect(() => {
    if (!activeTab) {
      setActiveParentDbSchema(null);
      return;
    }
    const clean = activeTab.path.replace(/^\/+|\/+$/g, '');
    if (clean.toLowerCase() === '_index.md') {
      setActiveParentDbSchema(null);
      return;
    }
    const baseManage = clean.toLowerCase().endsWith('/_index.md')
      ? clean.slice(0, -'/_index.md'.length)
      : clean;
    const slash = baseManage.lastIndexOf('/');
    if (slash === -1) {
      setActiveParentDbSchema(null);
      return;
    }
    const parentIndexPath = `${baseManage.slice(0, slash)}/_index.md`;
    const parentPage = pages.find(
      (p) => p.path.toLowerCase() === parentIndexPath.toLowerCase() && p.tipo === 'database',
    );
    if (!parentPage) {
      setActiveParentDbSchema(null);
      return;
    }
    let cancelled = false;
    void api
      .getDatabase(parentPage.id)
      .then((res) => {
        if (!cancelled) {
          setActiveParentDbSchema(res.schema);
        }
      })
      .catch(() => {
        if (!cancelled) setActiveParentDbSchema(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab?.path, pages]);

  const handleTreeMutatedFromTable = useCallback(
    async (convertedHost?: { from: string; to: string }) => {
      if (convertedHost) {
        const { from, to } = convertedHost;
        renamedPathMapRef.current.set(from, to);
        const convertedDir = nodeDirOfPagePath(to);
        remapClientPaths(
          (p) => (p.toLowerCase() === from.toLowerCase() ? to : p),
          convertedDir ? [convertedDir] : [],
        );
      }
      await refreshTreeAndPages(showArchived);
    },
    [refreshTreeAndPages, showArchived],
  );

  // Se l'utente non ha ancora il token autenticato, mostra schermata di accesso
  if (!isAuthenticated) {
    if (isGithubMode) {
      return (
        <div
          style={{
            width: '100vw',
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-app)',
            padding: '20px',
          }}
        >
          <div
            style={{
              maxWidth: '480px',
              width: '100%',
              padding: '32px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
              <span style={{ fontSize: '32px' }}>🧠</span>
              <div>
                <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0 }}>Second Brain</h2>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                  Connessione Knowledge Base (GitHub)
                </p>
              </div>
            </div>

            <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '20px' }}>
              La webapp di frontend è separata e indipendente dalle tue note.
              Inserisci il tuo <strong>GitHub Personal Access Token</strong> per accedere in sicurezza al tuo repository privato.
            </p>

            {authError && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-md)',
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid var(--danger, #ef4444)',
                  color: 'var(--danger, #ef4444)',
                  fontSize: '13px',
                  marginBottom: '16px',
                }}
              >
                <AlertTriangle size={16} />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={handleGithubConnect}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Owner
                  </label>
                  <input
                    type="text"
                    value={ghOwner}
                    onChange={(e) => setGhOwner(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-sidebar)',
                      fontSize: '13px',
                      color: 'var(--text-main)',
                    }}
                    required
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Repository
                  </label>
                  <input
                    type="text"
                    value={ghRepo}
                    onChange={(e) => setGhRepo(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-sidebar)',
                      fontSize: '13px',
                      color: 'var(--text-main)',
                    }}
                    required
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Branch
                  </label>
                  <input
                    type="text"
                    value={ghBranch}
                    onChange={(e) => setGhBranch(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-sidebar)',
                      fontSize: '13px',
                      color: 'var(--text-main)',
                    }}
                    required
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Cartella note
                  </label>
                  <input
                    type="text"
                    value={ghFolder}
                    onChange={(e) => setGhFolder(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-strong)',
                      background: 'var(--bg-sidebar)',
                      fontSize: '13px',
                      color: 'var(--text-main)',
                    }}
                    required
                  />
                </div>
              </div>

              <div style={{ marginBottom: '18px' }}>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
                  GitHub Personal Access Token (PAT)
                </label>
                <input
                  type="password"
                  placeholder="Incolla token (ghp_... o github_pat_...)"
                  value={ghToken}
                  onChange={(e) => setGhToken(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-strong)',
                    background: 'var(--bg-sidebar)',
                    fontSize: '13px',
                    color: 'var(--text-main)',
                    outline: 'none',
                  }}
                  required
                />
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: 1.4 }}>
                  🔒 Memorizzato <strong>esclusivamente nel tuo browser</strong> (localStorage). Non passa per Cloudflare.
                </p>
              </div>

              <button
                type="submit"
                disabled={isValidating}
                style={{
                  width: '100%',
                  padding: '11px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--accent)',
                  color: '#ffffff',
                  border: 'none',
                  fontWeight: 600,
                  fontSize: '14px',
                  cursor: isValidating ? 'wait' : 'pointer',
                  opacity: isValidating ? 0.7 : 1,
                }}
              >
                {isValidating ? 'Verifica credenziali...' : 'Connetti alla Knowledge Base'}
              </button>
            </form>
          </div>
        </div>
      );
    }

    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-app)',
        }}
      >
        <div
          style={{
            maxWidth: '460px',
            padding: '32px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
            <KeyRound size={28} color="var(--accent)" />
            <h2 style={{ fontSize: '20px', fontWeight: 700 }}>brain — Accesso protetto</h2>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: '20px' }}>
            L'API di brain richiede un token di sicurezza locale per impedire accessi non autorizzati dal browser.
            <br />
            Apri l'indirizzo stampato nel terminale dall'avvio del server oppure incolla qui sotto il token:
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (tokenInput.trim()) {
                api.setToken(tokenInput.trim());
                setIsAuthenticated(true);
              }
            }}
          >
            <input
              type="text"
              placeholder="Incolla qui il token (da .brain/local.json)..."
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-sidebar)',
                marginBottom: '16px',
                fontSize: '13px',
                outline: 'none',
              }}
            />
            <button
              type="submit"
              style={{
                width: '100%',
                padding: '10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--accent)',
                color: '#ffffff',
                fontWeight: 600,
                fontSize: '14px',
              }}
            >
              Accedi alla Knowledge Base
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="ide-container">
      {/* Corpo Principale IDE */}
      <div className="ide-main">
        {/* Sidebar Albero Unico di Pagine */}
        <Tree
          entries={treeEntries}
          pages={pages}
          activePath={activePath}
          favorites={favorites}
          showArchived={showArchived}
          collapsedFolders={collapsedFolders}
          onToggleCollapse={handleToggleCollapse}
          onSelectFile={openFile}
          onCreateFile={handleCreateFile}
          onCreateSubpage={handleAddSubpageFromTree}
          onMoveIntoPage={handleMoveIntoPage}
          onRename={(from, to) => handleRename(from, to)}
          onArchive={handleArchive}
          onDelete={handleDeleteFile}
          onToggleFavorite={handleToggleFavorite}
          onToggleShowArchived={handleToggleShowArchived}
          selectedTag={selectedTag}
          onSelectTag={(t) => setSelectedTag(t)}
          tags={tags}
          renamingPath={renamingPath}
          onCancelRename={() => setRenamingPath(null)}
          liveTitleDrafts={liveTitleDrafts}
          onLiveTitleDraftChange={handleLiveTitleDraftChange}
          theme={theme}
          onToggleTheme={handleToggleTheme}
          rightPanelOpen={rightPanelOpen}
          onToggleRightPanel={handleToggleRightPanel}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen(!chatOpen)}
          isGithubMode={isGithubMode}
          githubRepo={`${ghOwner}/${ghRepo}`}
          onOpenGithubSettings={() => setGithubSettingsOpen(true)}
        />

        {/* Area Centrale Editor / Anteprima */}
        <div className="workspace-center">
          {/* Banner di Avviso Conflitto di Concorrenza (409) */}
          {externalConflict && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 16px',
                background: 'var(--warning-subtle)',
                color: 'var(--warning-text)',
                borderBottom: '1px solid var(--warning)',
                fontSize: '12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={16} />
                <span>
                  <strong>Attenzione:</strong> Il file è stato modificato su disco da un processo esterno.
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  style={{
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--warning)',
                    color: '#ffffff',
                    fontWeight: 600,
                  }}
                  onClick={() => openFile(externalConflict)}
                >
                  Ricarica da disco
                </button>
                <button
                  style={{ padding: '2px 8px', borderRadius: 'var(--radius-sm)', background: 'transparent' }}
                  onClick={() => setExternalConflict(null)}
                >
                  Ignora
                </button>
              </div>
            </div>
          )}

          {/* Toolbar della Scheda Attiva */}
          {activeTab ? (
            <>
              <div className="workspace-toolbar">
                <div className="breadcrumb-path">
                  <span>
                    {(() => {
                      if (isHomePage(activeTab.path)) return 'Home';
                      if (isNodeIndexPath(activeTab.path)) {
                        const nodeDir = nodeDirOfPagePath(activeTab.path)!;
                        const parts = nodeDir.split('/');
                        parts[parts.length - 1] = getNoteDisplayName(activeTab.path, liveTitleDrafts);
                        return parts.join(' / ');
                      }
                      const slash = activeTab.path.lastIndexOf('/');
                      const dir = slash >= 0 ? activeTab.path.slice(0, slash) : '';
                      const title = getNoteDisplayName(activeTab.path, liveTitleDrafts);
                      return dir ? `${dir.split('/').join(' / ')} / ${title}` : title;
                    })()}
                  </span>
                  {activeTab.dirty && (
                    <span style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 600 }}>
                      (non salvato)
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    className="view-mode-btn"
                    style={{
                      background: activeTab.dirty ? 'var(--accent)' : 'var(--bg-sidebar)',
                      color: activeTab.dirty ? '#ffffff' : 'var(--text-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                    onClick={handleSaveActiveFile}
                    title="Salva file (Ctrl+S)"
                  >
                    <Save size={12} /> Salva
                  </button>
                </div>
              </div>

              {/* Contenuto Scheda: Documento Notion Visivo Diretto */}
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {activeTab.path.toLowerCase().endsWith('.csv') ? (
                  <Preview
                    path={activeTab.path}
                    content={activeTab.content}
                    entries={treeEntries}
                    pages={pages}
                    liveTitleDrafts={liveTitleDrafts}
                    onOpenWikilink={(target) => {
                      const resolved = resolveInternalPageTarget(
                        target,
                        activeTab.path,
                        treeEntries,
                        pages,
                        liveTitleDrafts,
                      );
                      if (resolved) openFile(resolved.path);
                    }}
                    onTagClick={(tag) => setSelectedTag(tag)}
                  />
                ) : (
                  <Editor
                    path={activeTab.path}
                    value={activeTab.content}
                    onChange={(newVal) => {
                      setTabs((prev) =>
                        prev.map((t) =>
                          t.path === activeTab.path ? { ...t, content: newVal, dirty: true } : t,
                        ),
                      );
                    }}
                    theme={theme}
                    availableNotes={availableNotePaths}
                    entries={treeEntries}
                    pages={pages}
                    liveTitleDrafts={liveTitleDrafts}
                    onLiveTitleDraftChange={(draft) =>
                      handleLiveTitleDraftChange(activeTab.path, draft)
                    }
                    onCreateSubpage={handleCreateSubpageFromSlash}
                    onPatchFrontmatter={handlePatchActiveFrontmatter}
                    onTreeMutated={handleTreeMutatedFromTable}
                    topPanel={
                      activeTab.path.toLowerCase().endsWith('.md') &&
                      activeTab.path.toLowerCase() !== 'agents.md' &&
                      parsedActiveDoc?.frontmatter?.tipo !== 'database' ? (
                        <PropertiesPanel
                          frontmatter={parsedActiveDoc?.frontmatter ?? null}
                          keyOrder={parsedActiveDoc?.keyOrder ?? []}
                          databaseSchema={activeParentDbSchema}
                          onPatchProperty={handlePatchActiveFrontmatter}
                        />
                      ) : undefined
                    }
                    bottomPanel={
                      parsedActiveDoc?.frontmatter?.tipo === 'database' &&
                      activeTab.path.toLowerCase().endsWith('/_index.md') ? (
                        <TableViewWidget
                          hostPath={activeTab.path}
                          fullPageDatabase={true}
                          parsedBlock={{
                            ok: true,
                            config: {
                              fonte: `database ${
                                pages.find(
                                  (p) => p.path.toLowerCase() === activeTab.path.toLowerCase(),
                                )?.id ??
                                String(parsedActiveDoc.frontmatter.id ?? '')
                              }`,
                            },
                            source: {
                              type: 'database',
                              targetId:
                                pages.find(
                                  (p) => p.path.toLowerCase() === activeTab.path.toLowerCase(),
                                )?.id ??
                                String(parsedActiveDoc.frontmatter.id ?? ''),
                            },
                          }}
                          onOpenPage={openFile}
                          onTreeMutated={handleTreeMutatedFromTable}
                        />
                      ) : undefined
                    }
                    autoFocusTitle={autoFocusTitlePath === activeTab.path}
                    onTitleAutoFocused={() => setAutoFocusTitlePath(null)}
                    onSaveShortcut={handleSaveActiveFile}
                    onRenameTitle={(newName, opts) => {
                      const oldPath = opts?.fromPath ?? activeTab.path;
                      if (isHomePage(oldPath)) return;
                      if (isNodeIndexPath(oldPath)) {
                        const nodeDir = nodeDirOfPagePath(oldPath)!;
                        const slash = nodeDir.lastIndexOf('/');
                        const parentPrefix = slash >= 0 ? nodeDir.slice(0, slash + 1) : '';
                        handleRename(nodeDir, `${parentPrefix}${newName}`, {
                          silentOnConflict: Boolean(opts?.live),
                        });
                        return;
                      }
                      const slash = oldPath.lastIndexOf('/');
                      const dir = slash >= 0 ? oldPath.slice(0, slash + 1) : '';
                      const ext = oldPath.match(/\.[^/.]+$/)?.[0] || '.md';
                      handleRename(oldPath, `${dir}${newName}${ext}`, {
                        silentOnConflict: Boolean(opts?.live),
                      });
                    }}
                    onOpenWikilink={(target) => {
                      const resolved = resolveInternalPageTarget(
                        target,
                        activeTab.path,
                        treeEntries,
                        pages,
                        liveTitleDrafts,
                      );
                      if (resolved) {
                        openFile(resolved.path);
                      }
                    }}
                  />
                )}
              </div>
            </>
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                gap: '12px',
              }}
            >
              <FileCode size={36} color="var(--border-strong)" />
              <p style={{ fontSize: '14px' }}>Nessuna nota aperta.</p>
              <button
                className="view-mode-btn"
                style={{ background: 'var(--accent)', color: '#ffffff', padding: '6px 14px' }}
                onClick={() => setPaletteMode('quickOpen')}
              >
                Apri una nota (Ctrl+O)
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modale Command Palette / Apertura Rapida */}
      <CommandPalette
        isOpen={paletteMode !== null}
        mode={paletteMode || 'quickOpen'}
        onClose={() => setPaletteMode(null)}
        entries={treeEntries}
        pages={pages}
        onOpenFile={openFile}
        onCreateFile={handleCreateFile}
        onToggleTheme={handleToggleTheme}
      />

      {/* Modale Anteprima Storico Versioni */}
      <HistoryModal
        isOpen={historyModalVersionId !== null}
        onClose={() => setHistoryModalVersionId(null)}
        path={activePath ?? ''}
        versionId={historyModalVersionId}
        content={historyModalContent}
        onRestore={handleRestoreVersion}
      />

      {/* Pannello Chat AI (Disattivato — nessuna richiesta di rete) */}
      <ChatPanel
        isOpen={chatOpen}
        onClose={() => setChatOpen(false)}
        agentUrl={config?.agentDeny ? undefined : undefined}
      />

      {/* Modale Gestione Connessione GitHub */}
      {githubSettingsOpen && (
        <div
          className="modal-overlay"
          onClick={() => setGithubSettingsOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '440px',
              width: '100%',
              padding: '24px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '12px' }}>
              Stato Connessione GitHub
            </h3>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: '20px' }}>
              <div><strong>Repository:</strong> {api.github.getConfig().owner}/{api.github.getConfig().repo}</div>
              <div><strong>Branch:</strong> {api.github.getConfig().branch}</div>
              <div><strong>Cartella note:</strong> {api.github.getConfig().percorsoKb}/</div>
              <div style={{ marginTop: '8px', color: '#10b981', fontWeight: 600 }}>
                ● Connesso al repository privato
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  api.github.clearConfig();
                  setIsAuthenticated(false);
                  setTabs([]);
                  setActivePath(null);
                  setGithubSettingsOpen(false);
                }}
                style={{
                  padding: '8px 14px',
                  borderRadius: 'var(--radius-md)',
                  background: 'transparent',
                  border: '1px solid var(--border-strong)',
                  color: 'var(--danger, #ef4444)',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                Disconnetti
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={async () => {
                  await refreshTreeAndPages(showArchived);
                  setGithubSettingsOpen(false);
                }}
                style={{
                  padding: '8px 14px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-strong)',
                  color: 'var(--text-main)',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                Ricarica albero
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setGithubSettingsOpen(false)}
                style={{
                  padding: '8px 14px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--accent)',
                  color: '#ffffff',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: '13px',
                }}
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
