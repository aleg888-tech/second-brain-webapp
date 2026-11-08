import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..');

function runGit(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...options,
    }).trim();
  } catch (err) {
    if (err.stdout) console.log(err.stdout.toString().trim());
    if (err.stderr) console.error(err.stderr.toString().trim());
    throw err;
  }
}

function runGitSafe(args) {
  try {
    return {
      success: true,
      stdout: execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      }).trim(),
    };
  } catch (err) {
    return {
      success: false,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim(),
    };
  }
}

function getChanges() {
  const output = runGit(['status', '--porcelain', '-uall']);
  if (!output) return { kbChanges: [], outsideChanges: [] };

  const lines = output.split('\n').filter(Boolean);
  const kbChanges = [];
  const outsideChanges = [];

  for (const line of lines) {
    // line is "XY path" or "XY path -> path"
    const filePath = line.slice(3).replace(/^"|"$/g, '').trim();
    if (filePath.startsWith('kb/') || filePath.startsWith('kb\\')) {
      kbChanges.push(filePath);
    } else {
      outsideChanges.push(filePath);
    }
  }

  return { kbChanges, outsideChanges };
}

function checkUpstream() {
  const branchRes = runGitSafe(['rev-parse', '--abbrev-ref', '@{u}']);
  if (!branchRes.success) {
    return { hasUpstream: false, ahead: 0, behind: 0 };
  }
  const countRes = runGitSafe(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (!countRes.success) {
    return { hasUpstream: true, ahead: 0, behind: 0 };
  }
  const [aheadStr, behindStr] = countRes.stdout.split(/\s+/);
  return {
    hasUpstream: true,
    upstream: branchRes.stdout,
    ahead: Number(aheadStr) || 0,
    behind: Number(behindStr) || 0,
  };
}

function statusCommand() {
  console.log('=== STATO KB (knowledge base) ===');
  const { kbChanges, outsideChanges } = getChanges();

  if (kbChanges.length === 0) {
    console.log('✓ Nessuna modifica locale pendente in kb/.');
  } else {
    console.log(`! Modifiche locali in kb/ (${kbChanges.length} file):`);
    for (const f of kbChanges.slice(0, 10)) {
      console.log(`   - ${f}`);
    }
    if (kbChanges.length > 10) {
      console.log(`   ... e altri ${kbChanges.length - 10} file.`);
    }
  }

  if (outsideChanges.length > 0) {
    console.log(`\n[Nota] Sono presenti ${outsideChanges.length} modifiche al di fuori di kb/ (in webapp o configurazione).`);
  }

  const upstream = checkUpstream();
  if (!upstream.hasUpstream) {
    console.log('\n[Remoto] Nessun upstream/remote configurato.');
  } else {
    console.log(`\n[Remoto: ${upstream.upstream}]`);
    console.log(`   - Commit locali da inviare (ahead): ${upstream.ahead}`);
    console.log(`   - Commit remoti da ricevere (behind): ${upstream.behind}`);
  }
}

function syncCommand() {
  console.log('=== SINCRONIZZAZIONE KB ===');
  const { kbChanges, outsideChanges } = getChanges();

  if (outsideChanges.length > 0) {
    console.error('\n[BLOCCO DI SICUREZZA] Ci sono modifiche fuori dalla cartella kb/:');
    for (const f of outsideChanges.slice(0, 10)) {
      console.error(`   - ${f}`);
    }
    if (outsideChanges.length > 10) {
      console.error(`   ... e altri ${outsideChanges.length - 10} file.`);
    }
    console.error('\nkb:sync opera ESCLUSIVAMENTE sui contenuti in kb/.');
    console.error('Esegui il commit o lo stash delle modifiche al codice prima di sincronizzare la KB.');
    process.exit(1);
  }

  const hasLocalKb = kbChanges.length > 0;
  if (hasLocalKb) {
    console.log(`Staging modifiche in kb/...`);
    runGit(['add', 'kb']);

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const commitMsg = `kb: modifiche locali ${dateStr}`;

    console.log(`Commit: "${commitMsg}"...`);
    runGit(['commit', '-m', commitMsg]);
  } else {
    console.log('Nessuna modifica locale in kb/ da committare.');
  }

  const upstream = checkUpstream();
  if (!upstream.hasUpstream) {
    console.log('Nessun remote configurato. Commit locale effettuato; sincronizzazione remota saltata.');
    return;
  }

  console.log('Pull con rebase e autostash dal remote...');
  try {
    runGit(['pull', '--rebase', '--autostash']);
  } catch {
    console.error('\n[ERRORE] Conflitto durante il pull rebase. Risolvi il conflitto manualmente su kb/.');
    process.exit(1);
  }

  console.log('Push verso il remote...');
  try {
    runGit(['push']);
    console.log('✓ Sincronizzazione completata con successo!');
  } catch {
    console.error('\n[ERRORE] Push fallito.');
    process.exit(1);
  }
}

const command = process.argv[2] || 'status';
if (command === 'status') {
  statusCommand();
} else if (command === 'sync') {
  syncCommand();
} else {
  console.error(`Comando sconosciuto: ${command}. Uso: node scripts/kb-sync.js [status|sync]`);
  process.exit(1);
}
