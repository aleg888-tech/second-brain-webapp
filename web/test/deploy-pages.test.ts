import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adaptForPages,
  CSP_META,
  deployPages,
  REFERRER_META,
  runSecurityChecks,
} from '../../scripts/deploy-pages.js';

describe('deploy-pages: adattamenti e verifiche di sicurezza per GitHub Pages', () => {
  const tempDir = path.resolve(__dirname, 'fixtures', 'temp-dist-test');

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    // Crea un finto index.html compilato
    fs.writeFileSync(
      path.join(tempDir, 'index.html'),
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>App</title></head><body><div id="root"></div></body></html>',
      'utf-8',
    );
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('adatta index.html inserendo .nojekyll, 404.html, CSP e Referrer meta tags', () => {
    adaptForPages(tempDir);

    expect(fs.existsSync(path.join(tempDir, '.nojekyll'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, '404.html'))).toBe(true);

    const html = fs.readFileSync(path.join(tempDir, 'index.html'), 'utf-8');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain('name="referrer" content="no-referrer"');

    const notFoundHtml = fs.readFileSync(path.join(tempDir, '404.html'), 'utf-8');
    expect(notFoundHtml).toBe(html);
  });

  it('supera i controlli di sicurezza su un output pulito', () => {
    adaptForPages(tempDir);
    fs.writeFileSync(path.join(tempDir, 'app.js'), 'console.log("hello world");', 'utf-8');

    const result = runSecurityChecks(tempDir);
    expect(result.files.length).toBeGreaterThanOrEqual(3);
    expect(result.totalBytes).toBeGreaterThan(0);
  });

  it('blocca il deploy se rileva un finto token GitHub (ghp_ / github_pat_)', () => {
    adaptForPages(tempDir);
    // Inserisci un finto token
    fs.writeFileSync(
      path.join(tempDir, 'leaked-bundle.js'),
      'const auth = "ghp_FakeToken1234567890abcdef123456";',
      'utf-8',
    );

    expect(() => runSecurityChecks(tempDir)).toThrow(/Rilevato potenziale token GitHub/);
  });

  it('blocca il deploy se sono presenti file .env, .brain o sourcemap .map', () => {
    adaptForPages(tempDir);
    fs.writeFileSync(path.join(tempDir, '.env.production'), 'SECRET=123', 'utf-8');

    expect(() => runSecurityChecks(tempDir)).toThrow(/File ambiente non ammesso/);

    fs.unlinkSync(path.join(tempDir, '.env.production'));
    fs.writeFileSync(path.join(tempDir, 'bundle.js.map'), '{}', 'utf-8');
    expect(() => runSecurityChecks(tempDir)).toThrow(/Source map/);
  });

  it('blocca il deploy se sono presenti file di contenuti KB (.md o .csv)', () => {
    adaptForPages(tempDir);
    fs.writeFileSync(path.join(tempDir, 'nota-privata.md'), '# Segreto', 'utf-8');

    expect(() => runSecurityChecks(tempDir)).toThrow(/File di contenuti KB/);
  });

  it('la prova a secco (dry-run) esegue i controlli senza effettuare alcun push', () => {
    adaptForPages(tempDir);
    const res = deployPages({
      dryRun: true,
      skipBuild: true,
      targetDir: path.resolve(__dirname, 'non-existing-target'),
    });

    expect(res.dryRun).toBe(true);
    expect(res.success).toBe(true);
    expect(res.siteUrl).toBeDefined();
  });
});
