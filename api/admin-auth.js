// api/admin-auth.js
// Vercel Serverless Function — BCCI Bharuch Admin Authentication
// POST: Login (validate credentials, create session token)
// DELETE: Logout (destroy session)
// Credentials stored in environment variables, sessions in Redis

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ADMIN_SESSIONS_KEY = 'bcci:admin_sessions';
const ADMIN_RATE_LIMIT_KEY = 'bcci:ratelimit:admin_login';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function generateSessionToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 64; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

export default async function handler(req, res) {
  corsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') {
      // ── Admin Login ────────────────────────────────────────────────
      const { username, password } = req.body || {};

      if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password are required.' });
      }

      // Rate limiting: max 5 login attempts per minute
      const attempts = (await redis.get(ADMIN_RATE_LIMIT_KEY)) || 0;
      if (attempts >= 5) {
        return res.status(429).json({
          success: false,
          error: 'Too many login attempts. Please wait 60 seconds.'
        });
      }

      // Validate credentials against environment variables
      const validUsername = (process.env.ADMIN_USERNAME || '').toLowerCase().trim();
      const validPassword = (process.env.ADMIN_PASSWORD || '').trim();
      const validEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());

      const inputUser = username.toLowerCase().trim();
      const inputPass = password.trim();

      const isUsernameValid = inputUser === validUsername || validEmails.includes(inputUser);
      const isPasswordValid = inputPass === validPassword;

      // Increment rate limit counter
      await redis.set(ADMIN_RATE_LIMIT_KEY, attempts + 1, { ex: 60 });

      if (!isUsernameValid || !isPasswordValid) {
        console.log(`[BCCI Admin Auth] Failed login attempt for: ${inputUser}`);
        return res.status(401).json({
          success: false,
          error: 'Invalid administrator credentials.'
        });
      }

      // Create session token
      const sessionToken = generateSessionToken();
      const sessions = (await redis.get(ADMIN_SESSIONS_KEY)) || {};

      // Clean expired sessions
      const now = Date.now();
      for (const [token, session] of Object.entries(sessions)) {
        if (now - new Date(session.createdAt).getTime() > SESSION_DURATION_MS) {
          delete sessions[token];
        }
      }

      // Create new session
      sessions[sessionToken] = {
        username: inputUser,
        createdAt: new Date().toISOString(),
        ip: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
      };

      await redis.set(ADMIN_SESSIONS_KEY, sessions);

      // Reset rate limit on successful login
      await redis.del(ADMIN_RATE_LIMIT_KEY);

      console.log(`[BCCI Admin Auth] Successful login: ${inputUser}`);

      return res.status(200).json({
        success: true,
        message: 'Admin authenticated successfully.',
        session: {
          token: sessionToken,
          username: inputUser,
          createdAt: sessions[sessionToken].createdAt,
          expiresIn: SESSION_DURATION_MS,
        }
      });
    }

    if (req.method === 'DELETE') {
      // ── Admin Logout ───────────────────────────────────────────────
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '').trim();

      if (!token) {
        return res.status(400).json({ success: false, error: 'No session token provided.' });
      }

      const sessions = (await redis.get(ADMIN_SESSIONS_KEY)) || {};

      if (sessions[token]) {
        const username = sessions[token].username;
        delete sessions[token];
        await redis.set(ADMIN_SESSIONS_KEY, sessions);
        console.log(`[BCCI Admin Auth] Logged out: ${username}`);
      }

      return res.status(200).json({
        success: true,
        message: 'Logged out successfully.'
      });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed.' });

  } catch (err) {
    console.error('[BCCI Admin Auth API Error]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error. Please try again later.'
    });
  }
}
