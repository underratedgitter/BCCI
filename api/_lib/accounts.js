// api/_lib/accounts.js
// Secure credential hashing and Upstash Redis account persistence.
import crypto from 'node:crypto';
import { redis, KEYS, withRetry } from './redis.js';

import util from 'node:util';
const scryptAsync = util.promisify(crypto.scrypt);

/**
 * Hash a plaintext password using scrypt with a 16-byte random salt and 64-byte key.
 * @param {string} password - Candidate or new password.
 * @param {string} [existingSalt] - Optional salt (for re-hashing or testing).
 * @returns {Promise<{ hash: string, salt: string }>}
 */
export async function hashPasswordAsync(password, existingSalt = null) {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const buf = await scryptAsync(password, salt, 64);
  return { hash: buf.toString('hex'), salt };
}

export function hashPassword(password, existingSalt = null) {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

/**
 * Constant-time comparison between candidate password and stored scrypt hash.
 * @param {string} candidatePassword - Plaintext password attempt.
 * @param {string} storedHash - Stored hex-encoded scrypt hash.
 * @param {string} salt - Stored hex-encoded salt.
 * @returns {Promise<boolean>}
 */
export async function verifyPasswordAsync(candidatePassword, storedHash, salt) {
  if (!candidatePassword || !storedHash || !salt) return false;
  if (typeof candidatePassword !== 'string' || typeof storedHash !== 'string' || typeof salt !== 'string') {
    return false;
  }
  try {
    const buf = await scryptAsync(candidatePassword, salt, 64);
    const b = Buffer.from(storedHash, 'hex');
    if (buf.length !== b.length) return false;
    return crypto.timingSafeEqual(buf, b);
  } catch {
    return false;
  }
}

export function verifyPassword(candidatePassword, storedHash, salt) {
  if (!candidatePassword || !storedHash || !salt) return false;
  if (typeof candidatePassword !== 'string' || typeof storedHash !== 'string' || typeof salt !== 'string') {
    return false;
  }
  const candidateHash = crypto.scryptSync(candidatePassword, salt, 64).toString('hex');
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Fetch an applicant account record by email.
 * @param {string} email - Business email address.
 * @returns {Promise<{ email: string, passwordHash: string, salt: string, createdAt: string, updatedAt: string } | null>}
 */
export async function getAccount(email) {
  if (!email) return null;
  const key = KEYS.account(email);
  return withRetry(async () => {
    const raw = await redis.get(key);
    if (!raw) return null;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return raw;
  });
}

/**
 * Create or update an applicant account with hashed password credentials.
 * @param {string} email - Business email address.
 * @param {string} password - Plaintext password (min 8 chars validated by caller).
 * @returns {Promise<{ email: string, passwordHash: string, salt: string, createdAt: string, updatedAt: string }>}
 */
export async function saveAccount(email, password) {
  const cleanEmail = String(email).trim().toLowerCase();
  const { hash, salt } = await hashPasswordAsync(password);
  const now = new Date().toISOString();
  const current = await getAccount(cleanEmail);
  const account = {
    email: cleanEmail,
    passwordHash: hash,
    salt,
    createdAt: current?.createdAt || now,
    updatedAt: now,
    passwordUpdatedAt: now,
  };
  await withRetry(async () => {
    await redis.set(KEYS.account(cleanEmail), account);
  });
  return account;
}
