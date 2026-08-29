// Minimal in-memory server speaking the Upstash REST protocol, so the real
// @upstash/redis client (and therefore the real handlers) can be exercised
// without touching a live database.

import http from 'node:http';

const store = new Map();   // key -> string value
const expiries = new Map(); // key -> epoch ms
const zsets = new Map();   // key -> Map(member -> score)

function alive(key) {
  const exp = expiries.get(key);
  if (exp !== undefined && Date.now() > exp) {
    store.delete(key);
    zsets.delete(key);
    expiries.delete(key);
    return false;
  }
  return true;
}

function run(cmd) {
  const op = String(cmd[0]).toUpperCase();
  const key = cmd[1];
  if (key !== undefined) alive(key);

  switch (op) {
    case 'SET': {
      const value = cmd[2];
      const opts = cmd.slice(3).map((o) => String(o).toUpperCase());
      if (opts.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      expiries.delete(key);
      const exIdx = opts.indexOf('EX');
      if (exIdx !== -1) expiries.set(key, Date.now() + Number(cmd[3 + exIdx + 1]) * 1000);
      return 'OK';
    }
    case 'GET':
      return store.has(key) ? store.get(key) : null;
    case 'MGET':
      return cmd.slice(1).map((k) => (alive(k) && store.has(k) ? store.get(k) : null));
    case 'DEL': {
      let n = 0;
      for (const k of cmd.slice(1)) {
        if (store.delete(k)) n++;
        if (zsets.delete(k)) n++;
        expiries.delete(k);
      }
      return n;
    }
    case 'INCR': {
      const next = Number(store.get(key) || 0) + 1;
      store.set(key, String(next));
      return next;
    }
    case 'EXPIRE':
      expiries.set(key, Date.now() + Number(cmd[2]) * 1000);
      return 1;
    case 'TTL': {
      const exp = expiries.get(key);
      if (exp === undefined) return store.has(key) ? -1 : -2;
      return Math.max(0, Math.ceil((exp - Date.now()) / 1000));
    }
    case 'ZADD': {
      if (!zsets.has(key)) zsets.set(key, new Map());
      const z = zsets.get(key);
      for (let i = 2; i < cmd.length; i += 2) z.set(String(cmd[i + 1]), Number(cmd[i]));
      return 1;
    }
    case 'ZRANGE': {
      const z = zsets.get(key) || new Map();
      const rev = cmd.slice(4).map((o) => String(o).toUpperCase()).includes('REV');
      let members = [...z.entries()].sort((a, b) => (rev ? b[1] - a[1] : a[1] - b[1])).map((e) => e[0]);
      const start = Number(cmd[2]);
      const stop = Number(cmd[3]);
      return members.slice(start, stop < 0 ? members.length + stop + 1 : stop + 1);
    }
    case 'ZCARD':
      return (zsets.get(key) || new Map()).size;
    case 'ZREM': {
      const z = zsets.get(key) || new Map();
      let n = 0;
      for (const m of cmd.slice(2)) if (z.delete(String(m))) n++;
      return n;
    }
    default:
      throw new Error(`mock-redis: unsupported command ${op}`);
  }
}

// The real Upstash REST API base64-encodes string results when the client
// sends `Upstash-Encoding: base64` (which @upstash/redis does by default).
// Without this the client decodes plain strings as base64 and yields garbage.
function encodeResult(value, useBase64) {
  if (!useBase64) return value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => encodeResult(v, useBase64));
  return Buffer.from(String(value), 'utf8').toString('base64');
}

export function startMockRedis() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let payload;
        try {
          payload = body ? JSON.parse(body) : [];
        } catch {
          res.writeHead(400).end(JSON.stringify({ error: 'bad json' }));
          return;
        }
        const b64 = String(req.headers['upstash-encoding'] || '').toLowerCase() === 'base64';
        res.setHeader('Content-Type', 'application/json');
        try {
          if (req.url.endsWith('/pipeline') || req.url.endsWith('/multi-exec')) {
            res.end(JSON.stringify(payload.map((c) => ({ result: encodeResult(run(c), b64) }))));
          } else {
            res.end(JSON.stringify({ result: encodeResult(run(payload), b64) }));
          }
        } catch (err) {
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, server, store, zsets });
    });
  });
}
