import { describe, expect, it } from 'vitest';
import { KbService, MemoryHistoryStore, MemoryStorage } from '@brain/kb-core';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

describe('Sicurezza API (Host, Origin, Token)', () => {
  const dummyToken = 'secret-token-1234567890abcdef';

  const dummyConfig: AppConfig = {
    projectRoot: '/dummy/root',
    kbDir: '/dummy/root/kb',
    historyDir: '/dummy/root/.brain/history',
    localJsonPath: '/dummy/root/.brain/local.json',
    vistaJsonPath: '/dummy/root/.brain/vista.json',
    port: 4310,
    host: '127.0.0.1',
    webPort: 5173,
    allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    extensions: ['.md', '.csv', '.txt'],
    exclude: ['_archivio', '.git'],
    agentDeny: ['segreto'],
    agentUrl: '',
  };

  const storage = new MemoryStorage();
  const history = new MemoryHistoryStore();
  const kb = new KbService({
    storage,
    history,
    extensions: dummyConfig.extensions,
    exclude: dummyConfig.exclude,
    agentDeny: dummyConfig.agentDeny,
  });

  const app = createApp({
    config: dummyConfig,
    kb,
    token: dummyToken,
  });

  it('consente richieste senza token quando la verifica token è disattivata', async () => {
    const res = await app.request('/v1/status', {
      headers: {
        host: '127.0.0.1:4310',
      },
    });
    expect(res.status).toBe(200);
  });

  it('restituisce 403 se Host non è 127.0.0.1 o localhost', async () => {
    const res = await app.request('/v1/status', {
      headers: {
        host: 'evil-attacker.com',
        authorization: `Bearer ${dummyToken}`,
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('forbidden');
  });

  it('restituisce 403 se Origin proviene da sito web estraneo', async () => {
    const res = await app.request('/v1/status', {
      headers: {
        host: '127.0.0.1:4310',
        origin: 'http://malicious-website.com',
        authorization: `Bearer ${dummyToken}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it('accetta richieste valide e restituisce intestazioni CORS corrette', async () => {
    const res = await app.request('/v1/status', {
      headers: {
        host: '127.0.0.1:4310',
        origin: 'http://127.0.0.1:5173',
        authorization: `Bearer ${dummyToken}`,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:5173');
    const data = await res.json();
    expect(data).toHaveProperty('signature');
  });

  it('gestisce correttamente le richieste preflight OPTIONS con 204', async () => {
    const res = await app.request('/v1/status', {
      method: 'OPTIONS',
      headers: {
        host: '127.0.0.1:4310',
        origin: 'http://localhost:5173',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
});
