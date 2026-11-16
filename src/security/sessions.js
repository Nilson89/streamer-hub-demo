// Sessions: lange Zufalls-ID im Cookie, in der Datenbank steht nur ihr SHA-256-Hash.
import { randomId, sha256Hex } from './crypto.js';

export const SESSION_COOKIE = 'hub_session';
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

/** Liest den Cookie-Header in ein einfaches Objekt (ohne Zusatzpaket). */
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length > 8192) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const name = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function createSessions({ db, config }) {
  const cookieOptions = { httpOnly: true, sameSite: 'lax', path: '/', secure: config.isHttps };

  const readCookie = (req) => {
    const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return typeof value === 'string' && value.length >= 16 && value.length <= 200 ? value : null;
  };

  return {
    /** Neue Session anlegen und Cookie setzen. Gibt die Session-ID nie irgendwo anders aus. */
    async start(res, userId) {
      const id = randomId();
      const now = Date.now();
      await db('sessions').insert({ id_hash: sha256Hex(id), user_id: userId, created_at: now, expires_at: now + SESSION_MS });
      res.cookie(SESSION_COOKIE, id, { ...cookieOptions, maxAge: SESSION_MS });
    },

    /** Session aus dem Request nur auf dem Server löschen (direkt vor einem neuen Login). */
    async drop(req) {
      const value = readCookie(req);
      if (value) await db('sessions').where({ id_hash: sha256Hex(value) }).del();
    },

    /** Session auf dem Server löschen und Cookie entfernen (Logout). */
    async destroy(req, res) {
      await this.drop(req);
      res.clearCookie(SESSION_COOKIE, cookieOptions);
    },

    clearCookie(res) {
      res.clearCookie(SESSION_COOKIE, cookieOptions);
    },

    /** Middleware: hängt den eingeloggten Benutzer an req.user (oder null). */
    load() {
      return async (req, res, next) => {
        try {
          req.user = null;
          const value = readCookie(req);
          if (value) {
            const row = await db('sessions')
              .join('users', 'users.id', 'sessions.user_id')
              .where('sessions.id_hash', sha256Hex(value))
              .andWhere('sessions.expires_at', '>', Date.now())
              .first('users.*');
            if (row) req.user = row;
          }
          next();
        } catch (err) {
          next(err);
        }
      };
    },

    /** Abgelaufene Sessions wegräumen. */
    async cleanup() {
      await db('sessions').where('expires_at', '<=', Date.now()).del();
    },
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}
