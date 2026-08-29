// api/_lib/security.js
// Security headers applied in application code rather than host config.
//
// vercel.json can express these too, but that file means nothing on a VPS,
// behind nginx, or in Docker. Setting them here means the protections travel
// with the app to whatever host it lands on.

/**
 * Content-Security-Policy for the portal.
 * Must stay in step with what index.html actually loads:
 *   - Font Awesome stylesheet + webfonts from cdnjs
 *   - qrcode.min.js from cdnjs
 *   - DM Serif Display / Inter / JetBrains Mono from Google Fonts
 *   - inline styles and inline <script> blocks in index.html
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
  "font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'none'",
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
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

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
  ['UPSTASH_REDIS_REST_URL', 'Redis storage — applications and sessions cannot be saved'],
  ['UPSTASH_REDIS_REST_TOKEN', 'Redis storage — applications and sessions cannot be saved'],
  ['ADMIN_PASSWORD', 'admin sign-in is disabled'],
];

const RECOMMENDED = [
  ['ADMIN_EMAILS', 'admin sign-in and new-application notifications'],
  ['SMTP_USER', 'OTP and notification email (falls back to GMAIL_USER)'],
  ['SMTP_PASS', 'OTP and notification email (falls back to GMAIL_PASS)'],
  ['CRON_SECRET', 'the daily renewal-reminder job'],
  ['ALLOWED_ORIGIN', 'browser CORS — defaults to https://bccibharuch.in'],
];

/**
 * Reports configuration problems at startup instead of letting them surface
 * later as a form that silently fails.
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function checkConfig(env = process.env) {
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
