// Baut die Express-App zusammen: Sicherheits-Header, Routen, Fehlerbehandlung.
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { PUBLIC_DIR } from './config.js';
import { HttpError } from './errors.js';
import { log } from './log.js';
import { messagePage, setupPage } from './pages.js';
import { adminApiRoutes, adminPage } from './routes/admin.js';
import { apiRoutes } from './routes/api.js';
import { authRoutes } from './routes/auth.js';
import { overlayRoutes } from './routes/overlay.js';
import { webhookRoutes } from './routes/webhooks.js';
import { originCheck, requireJson } from './security/csrf.js';
import { apiLimiter, authLimiter } from './security/ratelimits.js';

/** Sicherheits-Header mit strenger Content-Security-Policy (kein Inline-JavaScript, nichts von fremden Servern). */
function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'media-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    xFrameOptions: { action: 'deny' },
  });
}

function base() {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.get('/healthz', (req, res) => {
    res.type('text/plain').send('ok');
  });
  return app;
}

const staticFiles = () => express.static(PUBLIC_DIR, { index: false, dotfiles: 'ignore' });

/** Setup-Modus: Es fehlt noch Konfiguration. Die App erklärt, was fehlt, und tut sonst nichts. */
export function createSetupApp(problems) {
  const app = base();
  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(setupPage(problems));
  });
  app.use(staticFiles());
  app.use((req, res) => {
    res.status(503).json({ error: 'setup_required' });
  });
  return app;
}

export function createApp(ctx) {
  const { config, sessions } = ctx;
  const app = base();
  // Online steht die App hinter einem Proxy. Ohne diese Zeile würden sich alle Zuschauer ein Rate-Limit teilen.
  if (config.isHttps) app.set('trust proxy', 1);

  // Twitch-Webhooks: vor der Origin-Prüfung, ihr Schutz ist die Signatur.
  app.use('/webhooks', webhookRoutes(ctx));

  // Ab hier gilt für jede verändernde Anfrage: Sie muss von unserer eigenen Adresse kommen.
  app.use(originCheck(config));

  app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
  app.use(staticFiles());

  app.use('/auth', authLimiter(), authRoutes(ctx));
  app.use('/overlay', overlayRoutes(ctx));
  app.get('/admin', sessions.load(), adminPage(ctx));

  const api = apiRoutes(ctx);
  api.use('/admin', adminApiRoutes(ctx));
  app.use(
    '/api',
    apiLimiter(),
    (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      next();
    },
    requireJson,
    express.json({ limit: '10kb' }),
    sessions.load(),
    api,
  );

  // Unbekannte Routen
  app.use((req, res) => {
    if (req.path.startsWith('/api/') || !req.accepts('html')) return res.status(404).json({ error: 'not_found' });
    res
      .status(404)
      .type('html')
      .send(messagePage({ title: 'Seite nicht gefunden', text: 'Diese Seite gibt es hier nicht.' }));
  });

  // Zentrale Fehlerbehandlung: Der Browser bekommt nur einen kurzen Code, nie Details.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      if (err.extra.retryAfter) res.set('Retry-After', String(err.extra.retryAfter));
      return res.status(err.status).json({ error: err.code });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_request' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (err?.type === 'charset.unsupported' || err?.type === 'encoding.unsupported') {
      return res.status(415).json({ error: 'unsupported_media_type' });
    }
    if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
      return res.status(400).json({ error: 'bad_request' });
    }
    log.error(`Unerwarteter Fehler bei ${req.method} ${String(req.path).slice(0, 80)}`, err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
