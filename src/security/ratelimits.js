// Rate-Limits gegen Massenanfragen. Antwort immer: 429 { "error": "rate_limited" }.
import { rateLimit } from 'express-rate-limit';

const handler = (req, res) => {
  res.status(429).json({ error: 'rate_limited' });
};

const base = { standardHeaders: 'draft-7', legacyHeaders: false, handler };

/** Login-Routen: 60 Anfragen pro 15 Minuten und IP. */
export const authLimiter = () => rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 60 });

/** API: 300 Anfragen pro Minute und IP. */
export const apiLimiter = () => rateLimit({ ...base, windowMs: 60 * 1000, limit: 300 });

/** Einlösen: zusätzlich 10 pro Minute und Benutzer (läuft erst nach der Login-Prüfung). */
export const redeemLimiter = () =>
  rateLimit({
    ...base,
    windowMs: 60 * 1000,
    limit: 10,
    keyGenerator: (req) => `benutzer:${req.user.id}`,
  });
