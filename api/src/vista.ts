import { existsSync, promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { Vista } from '@brain/shared';

export const DEFAULT_VISTA: Vista = {
  theme: 'auto',
  favorites: ['_index.md'],
  collapsed: [],
  showArchived: false,
  chatOpen: false,
  rightPanelOpen: true,
  viewMode: 'edit',
  openTabs: ['_index.md'],
  activePath: '_index.md',
};

export class VistaStore {
  constructor(private readonly filePath: string) {}

  async get(): Promise<Vista> {
    try {
      if (!existsSync(this.filePath)) return { ...DEFAULT_VISTA };
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        theme: parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'auto' ? parsed.theme : DEFAULT_VISTA.theme,
        favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter((f: unknown) => typeof f === 'string') : DEFAULT_VISTA.favorites,
        collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.filter((c: unknown) => typeof c === 'string') : DEFAULT_VISTA.collapsed,
        showArchived: typeof parsed.showArchived === 'boolean' ? parsed.showArchived : DEFAULT_VISTA.showArchived,
        chatOpen: typeof parsed.chatOpen === 'boolean' ? parsed.chatOpen : DEFAULT_VISTA.chatOpen,
        rightPanelOpen: typeof parsed.rightPanelOpen === 'boolean' ? parsed.rightPanelOpen : DEFAULT_VISTA.rightPanelOpen,
        viewMode: parsed.viewMode === 'edit' || parsed.viewMode === 'preview' || parsed.viewMode === 'split' ? parsed.viewMode : DEFAULT_VISTA.viewMode,
        openTabs: Array.isArray(parsed.openTabs) ? parsed.openTabs.filter((t: unknown) => typeof t === 'string') : DEFAULT_VISTA.openTabs,
        activePath: typeof parsed.activePath === 'string' || parsed.activePath === null ? parsed.activePath : DEFAULT_VISTA.activePath,
      };
    } catch {
      return { ...DEFAULT_VISTA };
    }
  }

  async update(patch: Partial<Vista>): Promise<Vista> {
    const current = await this.get();
    const updated: Vista = {
      theme: patch.theme ?? current.theme,
      favorites: patch.favorites ?? current.favorites,
      collapsed: patch.collapsed ?? current.collapsed,
      showArchived: patch.showArchived ?? current.showArchived,
      chatOpen: patch.chatOpen ?? current.chatOpen,
      rightPanelOpen: patch.rightPanelOpen ?? current.rightPanelOpen,
      viewMode: patch.viewMode ?? current.viewMode,
      openTabs: patch.openTabs !== undefined ? patch.openTabs : current.openTabs,
      activePath: patch.activePath !== undefined ? patch.activePath : current.activePath,
    };
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    return updated;
  }
}
