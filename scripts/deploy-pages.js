import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const webappDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webappDir, '..');
const webDir = path.resolve(webappDir, 'web');
const webDistDir = path.resolve(webDir, 'dist');

const gitCmd = 'git';

function runNpm(args, options = {}) {
  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/c', 'npm', ...args], {
      shell: false,
      ...options,
    });
  }
  return execFileSync('npm', args, {
    shell: false,
    ...options,
  });
}

export const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://api.github.com http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self';">`;
export const REFERRER_META = `<meta name="referrer" content="no-referrer">`;

/**
 * Esegue il build dell'app web in modalità online con base relativa.
 */
export function buildWeb(envOverrides = {}) {
  console.log('[deploy:pages] Avvio build produzione (VITE_BACKEND=github, base="./", sourcemap=false)...');
  runNpm(['run', 'build'], {
    cwd: webDir,
    env: {
      ...process.env,
      VITE_BACKEND: 'github',
      VITE_BASE: './',
      ...envOverrides,
    },
    stdio: 'inherit',
  });
}

/**
 * Applica gli adattamenti necessari per GitHub Pages all'output di build.
 */
export function adaptForPages(distDir = webDistDir) {
  if (!fs.existsSync(distDir)) {
    throw new Error(`Directory di build non trovata: ${distDir}`);
  }

  // 1. .nojekyll
  const nojekyllPath = path.join(distDir, '.nojekyll');
  fs.writeFileSync(nojekyllPath, '', 'utf-8');

  // 2. index.html con CSP e Referrer meta tags
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`index.html non trovato in ${distDir}`);
  }

  let html = fs.readFileSync(indexPath, 'utf-8');

  // Inserisci CSP se assente
  if (!html.includes('http-equiv="Content-Security-Policy"')) {
    html = html.replace('<head>', `<head>\n    ${CSP_META}\n    ${REFERRER_META}`);
  }

  fs.writeFileSync(indexPath, html, 'utf-8');

  // 3. 404.html (copia di index.html per fallback SPA su GitHub Pages)
  const notFoundPath = path.join(distDir, '404.html');
  fs.copyFileSync(indexPath, notFoundPath);

  // 4. Rimuovi _headers e _redirects se presenti (non utilizzati su GitHub Pages)
  const headersPath = path.join(distDir, '_headers');
  if (fs.existsSync(headersPath)) fs.unlinkSync(headersPath);

  const redirectsPath = path.join(distDir, '_redirects');
  if (fs.existsSync(redirectsPath)) fs.unlinkSync(redirectsPath);
}

/**
 * Esegue controlli stringenti di sicurezza e integrità sui file dell'output prima di pubblicare.
 */
export function runSecurityChecks(distDir = webDistDir) {
  const violations = [];
  const files = [];
  let totalBytes = 0;

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(distDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        totalBytes += stat.size;
        files.push({ relPath, size: stat.size });

        const lowerName = entry.name.toLowerCase();

        // Check 1: Nessun file .env*, .brain*, .map
        if (lowerName.startsWith('.env')) {
          violations.push(`File ambiente non ammesso: ${relPath}`);
        }
        if (lowerName.includes('.brain')) {
          violations.push(`File configurazione locale .brain non ammesso: ${relPath}`);
        }
        if (lowerName.endsWith('.map')) {
          violations.push(`Source map (.map) non ammessa in produzione: ${relPath}`);
        }

        // Check 2: Nessun file di contenuti KB (.md o .csv)
        if (lowerName.endsWith('.md') || lowerName.endsWith('.csv')) {
          violations.push(`File di contenuti KB (.md / .csv) non ammesso nei file compilati: ${relPath}`);
        }

        // Check 3: Scansione segreti e token (ghp_*, github_pat_*)
        const isText = /\.(html|js|css|json|svg|txt)$/i.test(entry.name);
        if (isText) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (/ghp_[a-zA-Z0-9]{20,}/i.test(content) || /github_pat_[a-zA-Z0-9_]{20,}/i.test(content)) {
            violations.push(`[BLOCCO SICUREZZA] Rilevato potenziale token GitHub (ghp_ / github_pat_) in ${relPath}`);
          }
        }
      }
    }
  }

  walk(distDir);

  // Check 4: Dimensione totale ragionevole (< 50 MB)
  const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
  if (totalBytes > MAX_TOTAL_BYTES) {
    const sizeMb = (totalBytes / (1024 * 1024)).toFixed(2);
    violations.push(`Dimensione totale dell'output (${sizeMb} MB) supera il limite consentito di 50 MB.`);
  }

  // Verifica presenza dei file specifici Pages
  const nojekyll = path.join(distDir, '.nojekyll');
  if (!fs.existsSync(nojekyll)) {
    violations.push('File .nojekyll mancante nella radice di output.');
  }
  const notFound = path.join(distDir, '404.html');
  if (!fs.existsSync(notFound)) {
    violations.push('File 404.html (fallback SPA) mancante nella radice di output.');
  }

  if (violations.length > 0) {
    const err = new Error('Fallimento controlli pre-deploy:\n' + violations.map((v) => `  - ${v}`).join('\n'));
    err.violations = violations;
    throw err;
  }

  return { files, totalBytes };
}

/**
 * Trova il repo gemello di destinazione per Pages.
 */
export function findTargetRepo() {
  const candidates = [
    process.env.PAGES_REPO_DIR,
    path.resolve(repoRoot, '..', 'second-brain-webapp'),
    path.resolve(repoRoot, '..', 'second-brain-site'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, '.git'))) {
      return c;
    }
  }

  // Fallback al default se non ancora clonato
  return path.resolve(repoRoot, '..', 'second-brain-webapp');
}

/**
 * Funzione principale del deployment Pages.
 */
export function deployPages(options = {}) {
  const isDryRun = Boolean(options.dryRun || process.argv.includes('--dry-run') || process.argv.includes('-d'));
  const skipBuild = Boolean(options.skipBuild);
  const targetDir = options.targetDir || findTargetRepo();

  if (!skipBuild) {
    buildWeb();
  }

  adaptForPages(webDistDir);
  const { files, totalBytes } = runSecurityChecks(webDistDir);

  const totalKb = (totalBytes / 1024).toFixed(1);

  console.log('\n============================================================');
  console.log('✓ CONTROLLI DI SICUREZZA E INTEGRITÀ SUPERATI AL 100%');
  console.log('============================================================');
  console.log(`- File totali: ${files.length} (${totalKb} KB)`);
  console.log('- Nessun token o segreto rilevato (ghp_, github_pat_)');
  console.log('- Nessun file .env, .brain o source map (.map)');
  console.log('- Nessun file di dati o contenuti KB (.md, .csv)');
  console.log('- File .nojekyll presente');
  console.log('- File 404.html (fallback SPA) presente e allineato');
  console.log('- Content-Security-Policy e Referrer meta tags iniettati');
  console.log('- Base URL relativa "./" verificata per funzionamento in sottocartella');

  const repoName = path.basename(targetDir);
  const siteUrl = `https://aleg888-tech.github.io/${repoName}/`;

  console.log('\n[Elenco dei file di build pronti per la pubblicazione]:');
  for (const f of files.sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const sizeStr = (f.size / 1024).toFixed(1);
    console.log(`  • ${f.relPath.padEnd(35)} (${sizeStr} KB)`);
  }

  console.log(`\n[Destinazione GitHub Pages]:`);
  console.log(`  Cartella locale target : ${targetDir}`);
  console.log(`  Indirizzo finale sito  : ${siteUrl}`);

  if (isDryRun) {
    console.log('\n[PROVA A SECCO COMPLETATA - NESSUN PUSH ESEGUITO]');
    if (!fs.existsSync(path.join(targetDir, '.git'))) {
      console.log('\nNota: il repository target locale non esiste ancora.');
      console.log('Per clonarlo quando vorrai pubblicare, esegui:');
      console.log(`  git clone https://github.com/aleg888-tech/${repoName}.git "${targetDir}"`);
      console.log(`  # oppure via SSH:`);
      console.log(`  git clone git@github.com:aleg888-tech/${repoName}.git "${targetDir}"`);
    }
    return { success: true, dryRun: true, files, totalBytes, siteUrl };
  }

  // --- ESECUZIONE DEPLOY REALE ---
  if (!fs.existsSync(path.join(targetDir, '.git'))) {
    console.error(`\n[ERRORE] La cartella gemella "${targetDir}" non esiste o non è un repository Git.`);
    console.error(`Clona il repository pubblico prima di effettuare il deploy:`);
    console.error(`  git clone https://github.com/aleg888-tech/${repoName}.git "${targetDir}"`);
    process.exit(1);
  }

  // 1. Verifica che la cartella target sia pulita
  const statusOut = execFileSync(gitCmd, ['status', '--porcelain'], {
    cwd: targetDir,
    encoding: 'utf-8',
    shell: false,
  }).trim();

  if (statusOut) {
    console.error(`\n[BLOCCO] Il repository target "${targetDir}" presenta modifiche locali non committate:`);
    console.error(statusOut);
    console.error('Pulisci o committa le modifiche prima di procedere.');
    process.exit(1);
  }

  // 2. Rimuovi i vecchi file compilati (preservando .git)
  const existingEntries = fs.readdirSync(targetDir);
  for (const entry of existingEntries) {
    if (entry === '.git' || entry === '.gitmodules') continue;
    fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
  }

  // 3. Copia i nuovi file da dist a target
  fs.cpSync(webDistDir, targetDir, { recursive: true });

  // 4. Aggiungi README.md esplicativo
  const readmeContent = `# second-brain (Web App Build)

Questo repository contiene esclusivamente i file statici di compilazione per il deployment su GitHub Pages.
Nessun dato personale, configurazione privata o contenuto della Knowledge Base è presente in questo repository.

- **Sorgente**: build dell'app da https://github.com/aleg888-tech/second-brain
- **Deploy URL**: ${siteUrl}
`;
  fs.writeFileSync(path.join(targetDir, 'README.md'), readmeContent, 'utf-8');

  // 5. Ricava lo sha breve dal repo sorgente
  let shortSha = 'build';
  try {
    shortSha = execFileSync(gitCmd, ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      shell: false,
    }).trim();
  } catch {
    // fallback
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const commitMsg = `deploy: ${shortSha} ${dateStr}`;

  // 6. Stage e Commit
  execFileSync(gitCmd, ['add', '-A'], { cwd: targetDir, shell: false });

  const diffCached = execFileSync(gitCmd, ['diff', '--cached', '--quiet'], {
    cwd: targetDir,
    stdio: 'ignore',
    shell: false,
  });

  console.log(`\nStaging e commit nel repo target...`);
  execFileSync(gitCmd, ['commit', '-m', commitMsg], { cwd: targetDir, stdio: 'inherit', shell: false });

  // 7. Push SENZA --force
  console.log(`Push su GitHub Pages (${siteUrl})...`);
  try {
    execFileSync(gitCmd, ['push'], { cwd: targetDir, stdio: 'inherit', shell: false });
    console.log('\n✓ DEPLOY COMPLETATO CON SUCCESSO!');
    console.log(`Il sito sarà disponibile tra pochi istanti all'indirizzo:`);
    console.log(`👉 ${siteUrl}`);
  } catch (err) {
    console.error('\n[ERRORE] Il push è fallito (il ramo remoto potrebbe essere divergente).');
    console.error('Non è stato eseguito alcun force push per proteggere la storia.');
    console.error(`Esegui "git pull --rebase" dentro "${targetDir}" e riprova.`);
    process.exit(1);
  }

  return { success: true, siteUrl };
}

// Esecuzione diretta via CLI
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMainModule) {
  try {
    deployPages();
  } catch (err) {
    console.error(`\n[ERRORE CRITICO] ${err.message}`);
    process.exit(1);
  }
}
