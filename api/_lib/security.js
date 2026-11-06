// api/_lib/security.js
// Security headers applied in application code rather than host config.
//
// vercel.json sets them for production; setting them here as well means the
// local server (server.js) and the tests see exactly the same protections.

/**
 * Content-Security-Policy for the portal.
 * Must stay in step with what index.html actually loads:
 *   - Font Awesome stylesheet + webfonts from cdnjs
 *   - qrcode.min.js from /assets/vendor (self-hosted)
 *   - DM Serif Display / Inter / JetBrains Mono from Google Fonts
 *   - inline styles (no inline script: buttons use data-action handlers)
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
  "font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' blob: data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * How long browsers keep a static file. Photos and icons keep fixed names
 * (replacing nirmal-shah.webp keeps its name), so they get a day, then
 * refresh in the background; only the vendored libraries, which change
 * only with a new path, are kept for a year. vercel.json must say the same.
 */
export function assetCacheControl(relPath) {
  if (relPath.startsWith('assets/vendor/')) return 'public, max-age=31536000, immutable';
  if (relPath.startsWith('assets/')) return 'public, max-age=86400, stale-while-revalidate=604800';
  return 'public, max-age=604800';
}

/**
 * @param {boolean} https  Only send HSTS over TLS — sending it on plain HTTP
 *                         during local development locks the browser out of
 *                         http://localhost for two years.
 */
export function applySecurityHeaders(res, { https = false } = {}) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
  if (https) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
}

// ── Startup configuration check ────────────────────────────────────

const REQUIRED = [
  ['UPSTASH_REDIS_REST_URL', 'Redis — records, OTP codes, sessions and rate limits cannot be saved'],
  ['UPSTASH_REDIS_REST_TOKEN', 'Redis — records, OTP codes, sessions and rate limits cannot be saved'],
  ['ADMIN_PASSWORD', 'admin sign-in is disabled'],
];

const RECOMMENDED = [
  ['ADMIN_EMAILS', 'admin sign-in and new-application notifications'],
  ['SMTP_USER', 'OTP and notification email (falls back to GMAIL_USER)'],
  ['SMTP_PASS', 'OTP and notification email (falls back to GMAIL_PASS)'],
  ['ALLOWED_ORIGIN', 'browser CORS — defaults to https://bccibharuch.in'],
];

/**
 * The REST endpoint the Upstash client calls. A typo — a missing scheme, a URL
 * copied with a path — would otherwise surface only as failing requests.
 * Returns a problem worth reporting, or null when the value is usable.
 */
function redisUrlProblem(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return `UPSTASH_REDIS_REST_URL is not a URL ("${value}"). Use the REST URL from the Upstash console, e.g. https://your-instance.upstash.io.`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `UPSTASH_REDIS_REST_URL must start with https:// ("${value}" does not).`;
  }
  if (!url.hostname) {
    return `UPSTASH_REDIS_REST_URL has no host ("${value}"). Use the REST URL from the Upstash console, e.g. https://your-instance.upstash.io.`;
  }
  return null;
}

/**
 * ALLOWED_ORIGIN is compared character for character with the browser's Origin
 * header, which is a bare origin — scheme, host and port only. A path, a query
 * or a trailing slash there matches nothing, so each entry is checked and the
 * corrected form is suggested.
 */
function allowedOriginProblems(value) {
  const problems = [];
  for (const entry of String(value).split(',').map((o) => o.trim())) {
    if (!entry) continue;
    if (entry === '*' || entry.startsWith('*.')) {
      problems.push(`ALLOWED_ORIGIN entry "${entry}" is a wildcard — list the origins themselves, e.g. https://bccibharuch.in.`);
      continue;
    }
    let url;
    try {
      url = new URL(entry);
    } catch {
      problems.push(`ALLOWED_ORIGIN entry "${entry}" is not a URL — use a bare origin such as https://bccibharuch.in.`);
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      problems.push(`ALLOWED_ORIGIN entry "${entry}" must be an http(s) origin, e.g. https://bccibharuch.in.`);
      continue;
    }
    if (url.origin !== entry) {
      problems.push(`ALLOWED_ORIGIN entry "${entry}" must be a bare origin with no path, query or trailing slash — use "${url.origin}".`);
    }
  }
  return problems;
}

/**
 * Reports configuration problems at startup instead of letting them surface
 * later as a form that silently fails.
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
function checkConfig(env = process.env) {
  const errors = [];
  const warnings = [];

  for (const [key, why] of REQUIRED) {
    if (!env[key]) errors.push(`${key} is not set — ${why}.`);
  }
  for (const [key, why] of RECOMMENDED) {
    const fallback = key === 'SMTP_USER' ? env.GMAIL_USER
      : key === 'SMTP_PASS' ? env.GMAIL_PASS
      : key === 'ADMIN_EMAILS' ? env.ADMIN_USERNAME
      : undefined;
    if (!env[key] && !fallback) warnings.push(`${key} is not set — ${why}.`);
  }

  if (env.UPSTASH_REDIS_REST_URL) {
    const problem = redisUrlProblem(env.UPSTASH_REDIS_REST_URL);
    if (problem) errors.push(problem);
  }
  // A misspelt origin breaks CORS silently, so it is reported before it can.
  if (env.ALLOWED_ORIGIN) errors.push(...allowedOriginProblems(env.ALLOWED_ORIGIN));

  if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length < 12) {
    warnings.push('ADMIN_PASSWORD is shorter than 12 characters — use a long random secret.');
  }
  if (env.ADMIN_PASSWORD && /^(admin|password|123)/i.test(env.ADMIN_PASSWORD)) {
    errors.push('ADMIN_PASSWORD looks like a default or guessable value — change it.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Prints the config report. Returns false when something fatal is missing. */
export function reportConfig(env = process.env) {
  const { ok, errors, warnings } = checkConfig(env);
  for (const w of warnings) console.warn(`  [config] warning: ${w}`);
  for (const e of errors) console.error(`  [config] ERROR:   ${e}`);
  if (ok && !warnings.length) console.log('  [config] all required settings present');
  return ok;
}
