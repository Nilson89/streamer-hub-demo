// Schutz vor Anfragen von fremden Websites (CSRF).
// Jede verändernde Anfrage muss von unserer eigenen Adresse kommen.
const CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function originCheck(config) {
  return (req, res, next) => {
    if (!CHANGING.has(req.method)) return next();
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin !== config.baseOrigin) {
      return res.status(403).json({ error: 'forbidden_origin' });
    }
    next();
  };
}

/** Unter /api müssen verändernde Anfragen JSON sein. */
export function requireJson(req, res, next) {
  if (!CHANGING.has(req.method)) return next();
  const type = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'application/json') return res.status(415).json({ error: 'unsupported_media_type' });
  next();
}
