import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adaptForPages } from '../../scripts/deploy-pages.js';

describe('Verifica funzionamento dell\'app servita da una sottocartella (/second-brain-site/)', () => {
  let server: http.Server;
  let port: number;
  const distDir = path.resolve(__dirname, '..', 'dist');
  const subpath = '/second-brain-site';

  beforeAll(async () => {
    // Assicura gli adattamenti (404.html, CSP, .nojekyll)
    adaptForPages(distDir);

    server = http.createServer((req, res) => {
      const urlPath = (req.url || '').split('?')[0];
      if (!urlPath.startsWith(subpath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      let rel = urlPath.slice(subpath.length);
      if (rel === '' || rel === '/') rel = '/index.html';
      const filePath = path.join(distDir, rel);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const mime =
          ext === '.html'
            ? 'text/html'
            : ext === '.js'
              ? 'application/javascript'
              : ext === '.css'
                ? 'text/css'
                : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, Connection: 'close' });
        res.end(fs.readFileSync(filePath));
      } else {
        // SPA fallback tramite 404.html
        const fallbackPath = path.join(distDir, '404.html');
        res.writeHead(200, { 'Content-Type': 'text/html', Connection: 'close' });
        res.end(fs.readFileSync(fallbackPath));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('serve index.html su /second-brain-site/ con link relativi e CSP', async () => {
    const res = await fetch(`http://127.0.0.1:${port}${subpath}/`, {
      headers: { Connection: 'close' },
    });
    expect(res.status).toBe(200);

    const html = await res.text();
    // Verifica che gli asset siano relativi (./assets/...)
    expect(html).toContain('src="./assets/');
    expect(html).toContain('href="./assets/');
    // Verifica meta tag CSP e referrer
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain('name="referrer" content="no-referrer"');
  });

  it('serve correttamente gli asset JS e CSS sotto la sottocartella', async () => {
    const indexRes = await fetch(`http://127.0.0.1:${port}${subpath}/`, {
      headers: { Connection: 'close' },
    });
    const html = await indexRes.text();
    const jsMatch = html.match(/src="\.\/assets\/(index-[^"]+\.js)"/);
    expect(jsMatch).not.toBeNull();

    const jsFile = jsMatch![1];
    const assetRes = await fetch(`http://127.0.0.1:${port}${subpath}/assets/${jsFile}`, {
      headers: { Connection: 'close' },
    });
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get('content-type')).toContain('javascript');
  });

  it('effettua il fallback su 404.html per rotte SPA annidate', async () => {
    const res = await fetch(`http://127.0.0.1:${port}${subpath}/note/pagina-concettuale`, {
      headers: { Connection: 'close' },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="./assets/');
  });
});
