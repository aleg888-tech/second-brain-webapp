import { beforeEach, describe, expect, it } from 'vitest';
import {
  decodeBase64Utf8,
  encodeBase64Utf8,
  GithubClient,
} from '../src/api/githubClient.js';

describe('GithubClient & GitHub Mode Online Adapter', () => {
  let client: GithubClient;

  beforeEach(() => {
    localStorage.clear();
    client = new GithubClient();
  });

  describe('Codifica e decodifica UTF-8 / Base64', () => {
    it('preserva emoji, caratteri accentati e formattazione complessa', () => {
      const original = `# 🧠 Second Brain — Nota di Prova 🏋️‍♂️
- Città, perché, qualità, caffè
- Caratteri speciali: <tag> & "virgolette" 'apici' \`codice\`
- Emoji varie: ⚡ 🚀 📦 🛡️
`;
      const encoded = encodeBase64Utf8(original);
      const decoded = decodeBase64Utf8(encoded);
      expect(decoded).toBe(original);
    });
  });

  describe('Validazione e Guardrail di sicurezza percorsi', () => {
    it('normalizza percorsi validi relativi alla KB', () => {
      expect(client.validatePath('nota.md')).toBe('nota.md');
      expect(client.validatePath('allenamento/scheda.md')).toBe('allenamento/scheda.md');
      expect(client.validatePath('/domini/corsa/_index.md')).toBe('domini/corsa/_index.md');
      expect(client.validatePath('allegati\\immagine.png')).toBe('allegati/immagine.png');
    });

    it('blocca tentativi di path traversal', () => {
      expect(() => client.validatePath('../segreto.txt')).toThrow('Path traversal vietato');
      expect(() => client.validatePath('note/../../password.env')).toThrow('Path traversal vietato');
      expect(() => client.validatePath('./nota.md')).toThrow('Path traversal vietato');
    });

    it('blocca accessi alle cartelle protette di codice o configurazione', () => {
      expect(() => client.validatePath('webapp/package.json')).toThrow('Accesso vietato alla cartella di sistema');
      expect(() => client.validatePath('.github/workflows/deploy.yml')).toThrow('Accesso vietato alla cartella di sistema');
      expect(() => client.validatePath('node_modules/vite/package.json')).toThrow('Accesso vietato alla cartella di sistema');
      expect(() => client.validatePath('.brain/local.json')).toThrow('Accesso vietato alla cartella di sistema');
    });
  });

  describe('Configurazione e Token in localStorage', () => {
    it('ha default sicuri per owner, repo, branch e cartella', () => {
      const cfg = client.getConfig();
      expect(cfg.owner).toBe('aleg888-tech');
      expect(cfg.repo).toBe('second-brain');
      expect(cfg.branch).toBe('main');
      expect(cfg.percorsoKb).toBe('kb');
      expect(cfg.token).toBe('');
      expect(client.hasToken()).toBe(false);
    });

    it('salva e ripulisce le credenziali in localStorage', () => {
      client.setConfig({
        owner: 'aleg888-tech',
        repo: 'second-brain',
        branch: 'main',
        percorsoKb: 'kb',
        token: 'ghp_fakeTokenTest1234567890',
      });

      expect(client.hasToken()).toBe(true);
      expect(client.getConfig().token).toBe('ghp_fakeTokenTest1234567890');

      client.clearConfig();
      expect(client.hasToken()).toBe(false);
      expect(client.getConfig().token).toBe('');
    });
  });

  describe('Persistenza Vista in localStorage', () => {
    it('restituisce default coerenti e aggiorna le preferenze utente', async () => {
      const initial = await client.getVista();
      expect(initial.theme).toBe('dark');
      expect(initial.favorites).toEqual(['_index.md']);

      const updated = await client.updateVista({
        theme: 'light',
        favorites: ['_index.md', 'allenamento/_index.md'],
        openTabs: ['allenamento/_index.md'],
      });

      expect(updated.theme).toBe('light');
      expect(updated.favorites).toContain('allenamento/_index.md');

      const reloaded = await client.getVista();
      expect(reloaded.theme).toBe('light');
      expect(reloaded.openTabs).toEqual(['allenamento/_index.md']);
    });
  });
});
