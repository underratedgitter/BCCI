#!/usr/bin/env node
/**
 * Local server for the BCCI portal. Production runs on Vercel.
 *
 * Serves the same api/*.js handlers that Vercel runs as serverless functions,
 * plus the static site, so `npm run dev` and the end-to-end tests exercise
 * the real routes. It pulls in no dependencies beyond what the API needs.
 *
 *   node server.js                 # port 3000
 *   PORT=8080 node server.js
 *
 * Set TRUST_PROXY=1 only behind a proxy you control: it makes the server
 * read client IPs from X-Forwarded-For, which rate limiting depends on.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applySecurityHeaders, reportConfig, assetCacheControl } from './api/_lib/security.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const BEHIND_TLS = process.env.BEHIND_TLS === '1' || TRUST_PROXY;

// A handler that hangs must not pin a worker forever.
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
// Structured one-line-per-request logs (requestId + duration) for p95/p99 work.
const LOG_JSON = process.env.LOG_JSON === '1';

// Only these directories are served. Everything else 404s, so a stray file in
// the project root can never be fetched.
const STATIC_DIRS = new Set(['css', 'js', 'assets']);
const ROOT_FILES = new Set(['robots.txt', 'sitemap.xml', 'favicon.ico']);
// Crawler-facing root files are requested under a fixed name and cannot be
// cache-busted with ?v=, so they get an hour instead of the asset week.
const ROOT_FILE_CACHE = 'public, max-age=3600';

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

const MAX_BODY = 5 * 1024 * 1024; // 5MB — multi-document applications run ~2-3MB

// ── Adapt Node's req/res to the handler API the routes expect ──────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('Payload too large'), { statusCode: 413 });
    if (Number(req.headers['content-length']) > MAX_BODY) {
      reject(tooLarge());
      return;
    }
    let size = 0;
    const chunks = [];
    const onData = (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // Stop reading but keep the socket: destroying it here would kill the
        // connection before the 413 below could be written. The 413 path
        // closes the connection once the response is out.
        req.off('data', onData);
        req.pause();
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
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

// Route aliases map legacy/consolidated endpoints to their host function
const ROUTE_ALIASES = {
  'admin-stats': 'applications',
};

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

/** Does the request already hold this representation? (RFC 9110 §13.2.2) */
function isFresh(req, { etag, lastModified }) {
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) {
    // If-None-Match wins over If-Modified-Since whenever it is present.
    const strip = (tag) => tag.trim().replace(/^W\//, '');
    return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || strip(tag) === strip(etag));
  }
  const ifModifiedSince = req.headers['if-modified-since'];
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    // HTTP dates have second granularity, so compare whole seconds.
    if (Number.isFinite(since)) return Math.floor(lastModified.getTime() / 1000) <= Math.floor(since / 1000);
  }
  return false;
}

/**
 * Streams one file from disk. Returns false when there is nothing to serve, so
 * the caller chooses between a 404 and the SPA fallback.
 */
async function serveStatic(req, res, relPath, { baseDir = ROOT, cacheControl = ROOT_FILE_CACHE } = {}) {
  // Reject traversal markers outright
  const parts = relPath.split(/[/\\]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => p === '..' || p === '.')) return false;

  const targetDir = path.resolve(baseDir);
  const full = path.resolve(targetDir, ...parts);

  // Strictly enforce that the resolved path is within targetDir
  if (full !== targetDir && !full.startsWith(targetDir + path.sep)) return false;

  let stat;
  try {
    stat = await fs.stat(full);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }

  const ext = path.extname(full).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', cacheControl);

  // HEAD wants the headers only; Node would discard the body anyway.
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  const stream = createReadStream(full);
  // A read that fails after stat() (file deleted, permissions changed, disk
  // error) must answer the request — an unhandled 'error' event would take
  // the whole process down.
  stream.on('error', (err) => {
    console.error('[server] static read failed:', relPath, err?.code || err?.message || err);
    if (res.headersSent) {
      // Part of the body is already on the wire: abort rather than hang.
      res.destroy();
      return;
    }
    res.statusCode = 404;
    res.removeHeader('Content-Length');
    res.setHeader('Content-Type', MIME['.json']);
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  stream.pipe(res);
  return true;
}

async function serveIndex(req, res, statusCode = 200) {
  const file = path.join(ROOT, 'index.html');
  const [html, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
  // index.html has no ?v=, so it is revalidated on every load: the validators
  // let a returning browser skip the download with a 304.
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('ETag', etag);
  if (isFresh(req, { etag, lastModified: stat.mtime })) {
    // 304 carries headers only — no Content-Type and no body.
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', MIME['.html']);
  res.end(req.method === 'HEAD' ? undefined : html);
}

// ── Request handling ───────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  decorate(res);
  applySecurityHeaders(res, { https: BEHIND_TLS });

  // Request-scoped tracing + a hard ceiling so a hung handler cannot pin a
  // worker. requestId ties every log line for one request together.
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  const timeout = setTimeout(() => {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      // Nothing has gone out yet, so this can still be a proper JSON error.
      res.statusCode = 503;
      res.setHeader('Content-Type', MIME['.json']);
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Request timed out' }));
      return;
    }
    // The status line is already on the wire; all that is left is to stop.
    res.end();
  }, REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  res.on('close', () => {
    clearTimeout(timeout);
    if (LOG_JSON) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        requestId,
        method: req.method,
        path: req.url,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }));
    }
  });

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
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return res.status(400).json({ error: 'Bad request' });
  }

  try {
    // ── API ────────────────────────────────────────────────────────
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const rawName = pathname.slice(5);
      // Route names only: no slashes, no dots, no traversal.
      if (!/^[a-z0-9-]+$/i.test(rawName)) {
        return res.status(404).json({ error: 'Not found' });
      }

      const name = ROUTE_ALIASES[rawName] || rawName;
      const handler = await loadHandler(name);
      if (!handler) return res.status(404).json({ error: 'Not found' });

      req.query = Object.fromEntries(url.searchParams);
      if (rawName === 'admin-stats') {
        req.query.stats = 'true';
      }
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
    // Only read methods get this far: every other verb either belongs to a
    // handler above (which answers with its own 405) or is wrong for a file.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const segments = pathname.split('/').filter(Boolean);
    if (segments.some((s) => s === '..' || s === '.')) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (segments.length && STATIC_DIRS.has(segments[0])) {
      const dir = segments[0];
      const rel = segments.slice(1).join('/');
      if (!rel) return res.status(404).json({ error: 'Not found' });
      if (await serveStatic(req, res, rel, { baseDir: path.join(ROOT, dir), cacheControl: assetCacheControl(`${dir}/${rel}`) })) return;
      return res.status(404).json({ error: 'Not found' });
    }
    if (segments.length === 1 && ROOT_FILES.has(segments[0])) {
      // These resolve to a file or to nothing — never to the SPA's index.html,
      // which would answer a missing sitemap.xml with a 200 full of markup.
      if (await serveStatic(req, res, segments[0], { baseDir: ROOT, cacheControl: ROOT_FILE_CACHE })) return;
      return res.status(404).json({ error: 'Not found' });
    }

    // ── SPA fallback ───────────────────────────────────────────────
    // Mirrors the vercel.json rewrite, so /about, /services and the rest
    // resolve on a cold load.
    return await serveIndex(req, res);
  } catch (err) {
    if (err.statusCode === 413) {
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
      return res.status(413).json({ error: 'Request body too large' });
    }
    console.error('[server]', err?.stack || err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Boot ───────────────────────────────────────────────────────────

/** Exits before listen when an env knob is not a usable whole number. */
function checkIntEnv(name, value, { min, max, hint = '' }) {
  if (Number.isInteger(value) && value >= min && value <= max) return;
  const raw = process.env[name];
  console.error(
    `\n[server] Invalid ${name}${raw === undefined ? ' (not set)' : `="${raw}"`}: ` +
    `expected a whole number from ${min} to ${max}${hint ? ` (${hint})` : ''}.`
  );
  process.exit(1);
}

async function boot() {
  console.log('\nBCCI Bharuch portal');
  console.log('───────────────────');
  // Checked here, before listen, so a typo fails with a sentence instead of
  // a server bound to port NaN or a timeout of 0 ms.
  checkIntEnv('PORT', PORT, { min: 0, max: 65535, hint: '0 picks a free port' });
  checkIntEnv('REQUEST_TIMEOUT_MS', REQUEST_TIMEOUT_MS, { min: 1, max: 86_400_000, hint: 'milliseconds' });

  const configOk = reportConfig();
  if (!configOk && process.env.ALLOW_INCOMPLETE_CONFIG !== '1') {
    console.error('\nRefusing to start with missing required settings.');
    console.error('Fix the errors above, or set ALLOW_INCOMPLETE_CONFIG=1 to start anyway.\n');
    process.exit(1);
  }

  // Without this, a port already in use or a privileged port surfaces as an
  // unhandled 'error' event and a stack trace.
  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`\n[server] Port ${PORT} is already in use. Stop the process using it, or set PORT to another port.`);
    } else if (err?.code === 'EACCES') {
      console.error(`\n[server] Not allowed to bind ${HOST}:${PORT}. Ports below 1024 need elevated rights; set PORT to a port above 1024.`);
    } else {
      console.error('\n[server] Failed to start:', err?.message || err);
    }
    process.exit(1);
  });

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
}

await boot();

export default server;
