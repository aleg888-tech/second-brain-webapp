import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const webappDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webappDir, '..');
const kbDir = path.resolve(repoRoot, 'kb');

const violations = [];

// 1. Verifica KB: non deve contenere codice o dipendenze
if (fs.existsSync(kbDir)) {
  const FORBIDDEN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const FORBIDDEN_BASENAMES = new Set(['package.json', 'package-lock.json', 'node_modules', '.github', 'webapp']);

  function walkKb(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(repoRoot, fullPath);

      if (FORBIDDEN_BASENAMES.has(entry.name)) {
        violations.push(`File/cartella non consentita in kb: ${relPath}`);
        continue;
      }

      if (entry.isDirectory()) {
        walkKb(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (FORBIDDEN_EXTS.has(ext)) {
          violations.push(`File di codice non consentito in kb: ${relPath}`);
        }
      }
    }
  }

  walkKb(kbDir);
}

// 2. Verifica Webapp: non deve contenere file di conoscenza Markdown spuri
if (fs.existsSync(webappDir)) {
  const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.brain']);
  const ALLOWED_TOP_DOCS = new Set(['readme.md', 'agents.md', 'claude.md', 'changelog.md', 'license.md', 'contributing.md']);

  function walkWebapp(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relToWebapp = path.relative(webappDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        // Skip docs and fixtures directories entirely
        if (relToWebapp === 'docs' || relToWebapp.startsWith('docs/')) continue;
        if (relToWebapp.includes('/fixtures') || relToWebapp.endsWith('/fixtures') || relToWebapp.includes('test/fixtures')) continue;
        walkWebapp(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.md' || ext === '.markdown') {
          const lowerBase = entry.name.toLowerCase();
          if (!ALLOWED_TOP_DOCS.has(lowerBase)) {
            violations.push(`File markdown KB non ammesso in webapp: ${relToWebapp}`);
          }
        }
      }
    }
  }

  walkWebapp(webappDir);
}

if (violations.length > 0) {
  console.error('[check-separazione] RILEVATE VIOLAZIONI DI SEPARAZIONE TRA WEBAPP E KB:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
} else {
  console.log('[check-separazione] OK: separazione tra webapp/ e kb/ verificata con successo.');
  process.exit(0);
}
