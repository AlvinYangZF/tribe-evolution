#!/usr/bin/env node
/**
 * Static file server for the tribe-evolution frontend.
 *
 * Serves the contents of `web/` over HTTP. Pure file server — no API logic.
 * The frontend talks to the supervisor's API server (default localhost:3000)
 * over CORS using the `x-auth-token` bearer header.
 *
 * Usage:
 *   npm run web                    # serve web/ on http://localhost:3001
 *   WEB_PORT=8080 npm run web      # custom port
 *   WEB_DIR=./dist npm run web     # custom directory
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(__dirname, '..', 'web'));
const PORT = parseInt(process.env.WEB_PORT || '3001', 10);

const API_BACKEND = process.env.API_BACKEND || 'http://localhost:3000';


const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const filePath = path.resolve(path.join(WEB_DIR, pathname));
    // Block traversal attempts that escape WEB_DIR.
    if (!filePath.startsWith(WEB_DIR + path.sep) && filePath !== WEB_DIR) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Disable caching so dev edits show up on reload without a hard refresh.
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } else {
      console.error('[web-server]', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Frontend serving from ${WEB_DIR}`);
  console.log(`   http://localhost:${PORT}/`);
  console.log(`   (configure backend via ?api=<url> or localStorage.tribe_api_url; default http://localhost:3000)`);
});

const shutdown = () => { server.close(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
