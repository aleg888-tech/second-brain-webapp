import { promises as fs } from 'node:fs';
import { FsHistoryStore, FsStorage, KbService } from '@brain/kb-core';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { generateToken, saveLocalToken } from './security.js';

async function startServer(): Promise<void> {
  const config = loadConfig();

  // Assicura che la directory della KB esista
  await fs.mkdir(config.kbDir, { recursive: true });

  const storage = new FsStorage(config.kbDir);
  const history = new FsHistoryStore(config.historyDir);

  const kb = new KbService({
    storage,
    history,
    extensions: config.extensions,
    exclude: config.exclude,
    agentDeny: config.agentDeny,
  });

  await kb.refresh().catch((err) => {
    console.warn('[server] Scansione iniziale KB con avvisi:', err);
  });

  const token = generateToken();
  await saveLocalToken(config.localJsonPath, token, config.port);

  const app = createApp({ config, kb, token });

  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: config.host,
    },
    (info) => {
      const urlWithToken = `http://127.0.0.1:${config.webPort}/#token=${token}`;
      console.log('\n==============================================================');
      console.log(` 🧠 brain API avviata con successo!`);
      console.log(`    API URL:        http://${info.address}:${info.port}`);
      console.log(`    Knowledge Base: ${config.kbDir}`);
      console.log(`    AI Agent:       Non attivata (predisposta su ${config.agentUrl || 'porta 4311'})`);
      console.log('--------------------------------------------------------------');
      console.log(' 👉 Apri l\'interfaccia nel browser:');
      console.log(`    ${urlWithToken}`);
      console.log('==============================================================\n');
    },
  );

  const onExit = () => {
    console.log('\nChiusura server brain in corso...');
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);
}

startServer().catch((err) => {
  console.error('[server] Errore fatale all\'avvio del server:', err);
  process.exit(1);
});
