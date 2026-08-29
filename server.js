#!/usr/bin/env node
/**
 * Standalone HTTP server for the BCCI portal.
 *
 * The same api/*.js handlers that Vercel runs as serverless functions are
 * served here by a plain Node server, so the app runs unchanged on a VPS,
 * in Docker, or behind nginx. Nothing in this file is Vercel-specific and it
 * pulls in no dependencies beyond what the API already needs.
 *
 *   node server.js                 # port 3000
 *   PORT=8080 node server.js
 *
 * Behind nginx or any TLS terminator, set TRUST_PROXY=1 so client IPs are
 * read from X-Forwarded-For (rate limiting depends on getting this right).
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applySecurityHeaders, reportConfig } from './api/_lib/security.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const BEHIND_TLS = process.env.BEHIND_TLS === '1' || TRUST_PROXY;

// Only these directories are served. Everything else 404s, so a stray file in
// the project root can never be fetched.
const STATIC_DIRS = new Set(['css', 'js', 'assets']);
const ROOT_FILES = new Set(['robots.txt', 'sitemap.xml', 'favicon.ico']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_BODY = 2 * 1024 * 1024; // 2MB — receipts are capped well below this

// ── Adapt Node's req/res to the handler API the routes expect ──────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function decorate(res) {
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (obj) {
    if (!this.headersSent) this.setHeader('Content-Type', 'application/json; charset=utf-8');
    this.end(JSON.stringify(obj));
    return this;
  };
  return res;
}

// Handlers are loaded once and reused, the way a long-lived process should.
const handlerCache = new Map();

async function loadHandler(name) {
  if (handlerCache.has(name)) return handlerCache.get(name);
  // Route names are validated by the caller before reaching here.
  const file = path.join(ROOT, 'api', `${name}.js`);
  try {
    await fs.access(file);
  } catch {
    handlerCache.set(name, null);
    return null;
  }
  const mod = await import(pathToFileURL(file).href);
  const handler = mod.default || null;
  handlerCache.set(name, handler);
  return handler;
}

// ── Static files ───────────────────────────────────────────────────

async function serveStatic(res, relPath, { immutable = false } = {}) {
  const full = path.join(ROOT, relPath);
  // Defence in depth: never serve outside the project root.
  if (!full.startsWith(ROOT + path.sep)) return false;

  let stat;
  try {
    stat = await fs.stat(full);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  const ext = path.extname(full).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader(
    'Cache-Control',
    immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=604800'
  );
  createReadStream(full).pipe(res);
  return true;
}

async function serveIndex(res, statusCode = 200) {
  const html = await fs.readFile(path.join(ROOT, 'index.html'));
  res.statusCode = statusCode;
  res.setHeader('Content-Type', MIME['.html']);
  res.setHeader('Cache-Control', 'no-cache');
  res.end(html);
}

// ── Request handling ───────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  decorate(res);
  applySecurityHeaders(res, { https: BEHIND_TLS });

  if (!TRUST_PROXY) {
    // Without a trusted proxy, a client-supplied X-Forwarded-For would let
    // anyone forge their IP and sidestep every rate limit.
    delete req.headers['x-forwarded-for'];
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return res.status(400).json({ error: 'Bad request' });
  }
  const pathname = decodeURIComponent(url.pathname);

  try {
    // ── API ────────────────────────────────────────────────────────
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const name = pathname.slice(5);
      // Route names only: no slashes, no dots, no traversal.
      if (!/^[a-z0-9-]+$/i.test(name)) {
        return res.status(404).json({ error: 'Not found' });
      }

      const handler = await loadHandler(name);
      if (!handler) return res.status(404).json({ error: 'Not found' });

      req.query = Object.fromEntries(url.searchParams);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const raw = await readBody(req);
        if (raw) {
          try {
            req.body = JSON.parse(raw);
          } catch {
            return res.status(400).json({ error: 'Invalid JSON body' });
          }
        } else {
          req.body = {};
        }
      }

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return await handler(req, res);
    }

    // ── Static assets ──────────────────────────────────────────────
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length && STATIC_DIRS.has(segments[0])) {
      if (await serveStatic(res, segments.join('/'), { immutable: segments[0] === 'assets' })) return;
      return res.status(404).json({ error: 'Not found' });
    }
    if (segments.length === 1 && ROOT_FILES.has(segments[0])) {
      if (await serveStatic(res, segments[0])) return;
    }

    // ── SPA fallback ───────────────────────────────────────────────
    // Mirrors the vercel.json rewrite, so /about, /services and the rest
    // resolve on a cold load.
    return await serveIndex(res);
  } catch (err) {
    if (err.statusCode === 413) {
      return res.status(413).json({ error: 'Request body too large' });
    }
    console.error('[server]', err?.stack || err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Boot ───────────────────────────────────────────────────────────

console.log('\nBCCI Bharuch portal');
console.log('───────────────────');
const configOk = reportConfig();
if (!configOk && process.env.ALLOW_INCOMPLETE_CONFIG !== '1') {
  console.error('\nRefusing to start with missing required settings.');
  console.error('Fix the errors above, or set ALLOW_INCOMPLETE_CONFIG=1 to start anyway.\n');
  process.exit(1);
}

if (!TRUST_PROXY) {
  console.warn(
    '  [config] warning: TRUST_PROXY is not set. If this runs behind nginx,\n' +
    '                    Caddy or any reverse proxy, set TRUST_PROXY=1 — otherwise\n' +
    '                    every visitor looks like 127.0.0.1 and they all share one\n' +
    '                    rate-limit bucket, locking each other out.'
  );
}

server.listen(PORT, HOST, () => {
  console.log(`  listening on http://${HOST}:${PORT}`);
  console.log(`  health check: http://${HOST}:${PORT}/api/health\n`);
});

const shutdown = (signal) => {
  console.log(`\n${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default server;
