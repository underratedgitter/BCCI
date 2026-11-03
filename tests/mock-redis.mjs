// Minimal in-memory server speaking the Upstash REST protocol, so the real
// @upstash/redis client (and therefore the real handlers) can be exercised
// without touching a live database.

import http from 'node:http';

const store = new Map();   // key -> string value
const expiries = new Map(); // key -> epoch ms
const zsets = new Map();   // key -> Map(member -> score)
const failKeys = new Set(); // keys whose commands error, to simulate an outage
const beforeCommand = [];   // (cmd) => void, to interleave writes deterministically

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
  for (const hook of beforeCommand) hook(cmd);
  const key = cmd[1];
  if (failKeys.has(key)) throw new Error(`mock-redis: simulated failure for ${key}`);
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
    case 'GETDEL': {
      if (!store.has(key)) return null;
      const val = store.get(key);
      store.delete(key);
      expiries.delete(key);
      return val;
    }
    case 'EXISTS':
      return cmd.slice(1).filter((k) => alive(k) && (store.has(k) || zsets.has(k))).length;
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
    case 'INCR':
    case 'DECR': {
      const next = Number(store.get(key) || 0) + (op === 'INCR' ? 1 : -1);
      store.set(key, String(next));
      return next;
    }
    case 'EXPIRE':
      // As Redis: a missing key is left alone and reported as 0.
      if (!store.has(key) && !zsets.has(key)) return 0;
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
    case 'SCAN': {
      // [SCAN, cursor, MATCH, pattern, COUNT, n] — one page, always complete.
      const args = cmd.slice(2).map((a) => String(a).toUpperCase());
      const mi = args.indexOf('MATCH');
      const pattern = mi === -1 ? '*' : String(cmd[2 + mi + 1]);
      const rx = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      );
      const all = [...new Set([...store.keys(), ...zsets.keys()])].filter((k) => alive(k) && rx.test(k));
      return ['0', all];
    }
    case 'ZREM': {
      const z = zsets.get(key) || new Map();
      let n = 0;
      for (const m of cmd.slice(2)) if (z.delete(String(m))) n++;
      return n;
    }
    case 'EVAL': {
      // Two scripts are supported, both from api/_lib/redis.js.
      const [script, numKeys, ...rest] = cmd.slice(1);
      const n = Number(numKeys);
      const keys = rest.slice(0, n).map(String);
      const args = rest.slice(n).map(String);
      const lockHeld = alive(keys[0]) && store.get(keys[0]) === args[0];
      if (String(script).startsWith('-- bcci-fenced-write')) {
        // Apply every write only while KEYS[1] still holds ARGV[1].
        if (!lockHeld) return 0;
        // Fail before applying any writes, as an unavailable target would.
        if (keys.slice(1).some((key) => failKeys.has(key))) throw new Error('mock-redis: simulated fenced write failure');
        for (let i = 1; i < keys.length; i++) {
          const op = args[i][0];
          const arg = args[i].slice(2);
          if (op === 'S') { store.set(keys[i], arg); expiries.delete(keys[i]); }
          else if (op === 'D') { store.delete(keys[i]); zsets.delete(keys[i]); expiries.delete(keys[i]); }
          else if (op === 'Z') {
            const sep = arg.indexOf(':');
            if (!zsets.has(keys[i])) zsets.set(keys[i], new Map());
            zsets.get(keys[i]).set(arg.slice(sep + 1), Number(arg.slice(0, sep)));
          } else if (op === 'R') (zsets.get(keys[i]) || new Map()).delete(arg);
          else throw new Error(`mock-redis: unknown fenced op ${op}`);
        }
        return 1;
      }
      // Token-checked lock release: delete KEYS[1] when it still holds ARGV[1].
      if (!/redis\.call\("get",KEYS\[1\]\)==ARGV\[1\]/.test(String(script)) || n !== 1) {
        throw new Error('mock-redis: unsupported EVAL script');
      }
      if (!lockHeld) return 0;
      store.delete(keys[0]);
      expiries.delete(keys[0]);
      return 1;
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
            // Upstash reports errors per command inside a pipeline.
            res.end(JSON.stringify(payload.map((c) => {
              try {
                return { result: encodeResult(run(c), b64) };
              } catch (err) {
                return { error: err.message };
              }
            })));
          } else {
            res.end(JSON.stringify({ result: encodeResult(run(payload), b64) }));
          }
        } catch (err) {
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, server, store, zsets, failKeys, beforeCommand });
    });
  });
}
