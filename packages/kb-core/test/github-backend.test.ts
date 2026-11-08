import { describe, expect, it } from 'vitest';
import { GithubBackend } from '../src/storage/github-backend.js';
import { KbService } from '../src/kb-service.js';

describe('GithubBackend con prefisso e guard di sicurezza (Monorepo)', () => {
  it('rifiuta qualunque scrittura e path traversal al di fuori di kb/', async () => {
    const gh = new GithubBackend();

    // Tentativo di scrittura su cartella webapp
    await expect(gh.write('webapp/server.ts', 'codice malevolo')).rejects.toThrow(
      /Scrittura\/lettura vietata su "webapp"/,
    );

    // Tentativo di scrittura su .github/workflows
    await expect(gh.write('.github/workflows/ci.yml', 'hacked')).rejects.toThrow(
      /Scrittura\/lettura vietata su "\.github"/,
    );

    // Tentativo di path traversal
    await expect(gh.write('kb/../webapp/index.ts', 'evil')).rejects.toThrow(
      /Path traversal non consentito/,
    );
  });

  it('permette scritture all\'interno di kb/ (sia con prefisso esplicito che relativo)', async () => {
    const gh = new GithubBackend({
      profile: {
        nome: 'test',
        owner: 'aleg888-tech',
        repo: 'second-brain',
        branch: 'main',
        percorsoKb: 'kb',
      },
    });

    await gh.create('note/ciao.md', '# Ciao mondo');
    const read1 = await gh.read('note/ciao.md');
    expect(read1.content).toBe('# Ciao mondo');

    // Scrittura con prefisso esplicito
    await gh.write('kb/note/ciao.md', '# Ciao mondo aggiornato');
    const read2 = await gh.read('kb/note/ciao.md');
    expect(read2.content).toBe('# Ciao mondo aggiornato');

    // Controllo albero raw
    const raw = await gh.rawList();
    expect(raw.some((e) => e.path === 'kb/note/ciao.md')).toBe(true);
  });

  it('i commit generati usano sempre il prefisso "kb:"', async () => {
    const gh = new GithubBackend();
    expect(gh.formatCommitMessage('modifica nota')).toBe('kb: modifica nota');
    expect(gh.formatCommitMessage('kb: già prefissato')).toBe('kb: già prefissato');
    expect(gh.formatCommitMessage('')).toBe('kb: aggiornamento contenuto');

    const id = await gh.save('note/test.md', 'test content', 'creazione pagina');
    expect(id).toBeDefined();

    const history = await gh.listCommits('note/test.md');
    expect(history.length).toBe(1);
  });

  it('getRemoteTreeSha confronta solo lo sha della cartella kb/, non l\'head del repo', () => {
    const gh = new GithubBackend();

    const tree = [
      { path: 'webapp', sha: 'sha-webapp-123', type: 'tree' },
      { path: '.github', sha: 'sha-github-456', type: 'tree' },
      { path: 'kb', sha: 'sha-kb-789', type: 'tree' },
    ];

    const kbSha = gh.getRemoteTreeSha(tree);
    expect(kbSha).toBe('sha-kb-789');

    // Se cambia webapp ma non kb, kbSha rimane identico
    const treeUpdatedWebapp = [
      { path: 'webapp', sha: 'sha-webapp-MODIFICATO', type: 'tree' },
      { path: '.github', sha: 'sha-github-456', type: 'tree' },
      { path: 'kb', sha: 'sha-kb-789', type: 'tree' },
    ];
    expect(gh.getRemoteTreeSha(treeUpdatedWebapp)).toBe('sha-kb-789');
  });

  it('funziona perfettamente come storage per KbService', async () => {
    const gh = new GithubBackend();
    const kb = new KbService({
      storage: gh.storage,
      history: gh.history,
      extensions: ['.md', '.csv', '.txt'],
      exclude: ['_archivio', '.git'],
      now: () => new Date('2026-09-01T10:00:00Z'),
    });

    await kb.create('note/zettel.md', '---\ntitolo: Zettel\n---\nCorpo nota');
    const page = await kb.read('note/zettel.md');
    expect(page.content).toContain('Corpo nota');

    // Verifica che su storage sia sotto kb/
    const raw = await gh.rawList();
    expect(raw.some((e) => e.path === 'kb/note/zettel.md')).toBe(true);
  });
});
