// API-key plumbing. We never store the plaintext key — only sha256 — so a
// leaked DB can't be replayed. The key itself is 32 random bytes base64url'd.

import crypto from 'node:crypto';

export function generateApiKey() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashKey(k) {
  return crypto.createHash('sha256').update(k).digest('hex');
}

export function parseBearer(header) {
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Look the bearer up against the users table; returns the username row or
// null. Cheap because users is tiny (one row per real human).
export function authBearer(db, request) {
  const key = parseBearer(request.headers.authorization);
  if (!key) return null;
  const h = hashKey(key);
  const row = db.prepare('SELECT username FROM users WHERE api_key_hash = ?').get(h);
  return row ? row.username : null;
}

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
export function validUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}

const STATE_RE = /^[a-z_]{2,32}$/;
export function validState(s) {
  return typeof s === 'string' && STATE_RE.test(s);
}
