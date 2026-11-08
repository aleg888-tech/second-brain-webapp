import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import { forbidden } from '@brain/kb-core';
import type { AppConfig } from './config.js';

export interface LocalTokenData {
  token: string;
  port: number;
  pid: number;
  createdAt: string;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export async function saveLocalToken(filePath: string, token: string, port: number): Promise<void> {
  const data: LocalTokenData = {
    token,
    port,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Middleware di sicurezza che valida Host, Origin, CORS e Token di autorizzazione.
 */
export function createSecurityMiddleware(config: AppConfig, _activeToken?: string): MiddlewareHandler {
  const allowedHosts = new Set([
    `127.0.0.1:${config.port}`,
    `localhost:${config.port}`,
    '127.0.0.1',
    'localhost',
  ]);

  const allowedOriginsSet = new Set(config.allowedOrigins.map((o) => o.toLowerCase()));

  return async (c, next) => {
    const origin = c.req.header('origin');
    const host = c.req.header('host');

    // 1. Validazione Host (se presente)
    if (host) {
      const hostLower = host.toLowerCase();
      if (!allowedHosts.has(hostLower)) {
        throw forbidden(`Host non autorizzato: ${host}`);
      }
    }

    // 2. Validazione Origin (se presente)
    if (origin) {
      const originLower = origin.toLowerCase();
      if (!allowedOriginsSet.has(originLower)) {
        throw forbidden(`Origin non autorizzata: ${origin}`);
      }
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }

    // 3. Gestione preflight OPTIONS
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
      c.header('Access-Control-Max-Age', '86400');
      return c.body(null, 204);
    }

    // 4. Verifica Token Bearer (DISATTIVATA per ora su richiesta)
    /*
    const authHeader = c.req.header('authorization');
    let providedToken: string | null = null;

    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      providedToken = authHeader.slice(7).trim();
    } else {
      const queryToken = c.req.query('token');
      if (queryToken) providedToken = queryToken;
    }

    if (!providedToken || providedToken !== activeToken) {
      throw unauthorized('Token di autenticazione mancante o non valido.');
    }
    */

    await next();
  };
}
