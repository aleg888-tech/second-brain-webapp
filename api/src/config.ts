import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BrainConfig {
  kbPath: string;
  extensions: string[];
  exclude: string[];
  agentDeny: string[];
  agentUrl?: string;
}

export interface AppConfig {
  projectRoot: string;
  kbDir: string;
  historyDir: string;
  localJsonPath: string;
  vistaJsonPath: string;
  port: number;
  host: string;
  webPort: number;
  allowedOrigins: string[];
  extensions: string[];
  exclude: string[];
  agentDeny: string[];
  agentUrl: string;
}

const DEFAULT_EXTENSIONS = ['.md', '.csv', '.txt'];
const DEFAULT_EXCLUDE = ['_archivio', '.git'];

export function findProjectRoot(startDir = process.cwd()): string {
  let cur = resolve(startDir);
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(cur, '.brain', 'config.json'))) {
      return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    let fCur = here;
    for (let i = 0; i < 6; i++) {
      if (existsSync(resolve(fCur, '.brain', 'config.json'))) {
        return fCur;
      }
      const parent = dirname(fCur);
      if (parent === fCur) break;
      fCur = parent;
    }
  } catch {
    // fallback
  }
  return resolve(startDir);
}

export function loadConfig(startDir?: string): AppConfig {
  const projectRoot = findProjectRoot(startDir);

  const brainConfigPath = resolve(projectRoot, '.brain', 'config.json');
  let rawJson: Partial<BrainConfig> = {};
  if (existsSync(brainConfigPath)) {
    try {
      rawJson = JSON.parse(readFileSync(brainConfigPath, 'utf-8'));
    } catch (err) {
      console.warn(`[config] Impossibile leggere ${brainConfigPath}:`, err);
    }
  }

  const kbRel = process.env.KB_PATH || rawJson.kbPath || '../kb';
  const kbDir = resolve(projectRoot, kbRel);
  const historyDir = resolve(projectRoot, '.brain', 'history');
  const localJsonPath = resolve(projectRoot, '.brain', 'local.json');
  const vistaJsonPath = resolve(projectRoot, '.brain', 'vista.json');

  const port = Number(process.env.PORT) || 4310;
  const host = process.env.HOST || '127.0.0.1';
  const webPort = Number(process.env.WEB_PORT) || 5173;

  const allowedOrigins = [
    `http://localhost:${webPort}`,
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
  if (process.env.WEB_ORIGINS) {
    for (const o of process.env.WEB_ORIGINS.split(',')) {
      const clean = o.trim();
      if (clean && !allowedOrigins.includes(clean)) allowedOrigins.push(clean);
    }
  }

  const extensions = Array.isArray(rawJson.extensions) && rawJson.extensions.length > 0
    ? rawJson.extensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`))
    : DEFAULT_EXTENSIONS;

  const exclude = Array.isArray(rawJson.exclude) && rawJson.exclude.length > 0
    ? rawJson.exclude
    : DEFAULT_EXCLUDE;

  const agentDeny = Array.isArray(rawJson.agentDeny) ? rawJson.agentDeny : [];
  const agentUrl = typeof rawJson.agentUrl === 'string' ? rawJson.agentUrl : '';

  return {
    projectRoot,
    kbDir,
    historyDir,
    localJsonPath,
    vistaJsonPath,
    port,
    host,
    webPort,
    allowedOrigins,
    extensions,
    exclude,
    agentDeny,
    agentUrl,
  };
}
