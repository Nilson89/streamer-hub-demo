// Admin-Seite und Admin-API. Nur der Streamer selbst (Twitch-ID = Kanal-ID) kommt hier hinein.
import path from 'node:path';
import express from 'express';
import { VIEWS_DIR } from '../config.js';
import { messagePage } from '../pages.js';
import { requireAuth } from '../security/sessions.js';
import { listCurrencyImages, validateSettings } from '../services/settings.js';
import { noInput } from './api.js';

/** GET /admin: liefert die Seite nur an den Streamer aus. */
export function adminPage({ streamer }) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.redirect(302, '/auth/streamer');
    if (!streamer.isChannelUser(req.user.twitch_id)) {
      return res
        .status(403)
        .type('html')
        .send(messagePage({ title: 'Kein Zugriff', text: 'Diese Seite ist nur für den Streamer dieses Kanals.' }));
    }
    res.sendFile(path.join(VIEWS_DIR, 'admin.html'));
  };
}

export function adminApiRoutes({ config, settings, streamer, events }) {
  const router = express.Router();

  // Erst Login prüfen (401), dann Admin-Recht (403). Beides entscheidet der Server.
  router.use(requireAuth, (req, res, next) => {
    if (!streamer.isChannelUser(req.user.twitch_id)) return res.status(403).json({ error: 'forbidden' });
    next();
  });

  router.get('/settings', async (req, res) => {
    res.json({ settings: settings.get(), ...(await streamer.status()) });
  });

  router.put('/settings', async (req, res) => {
    const result = await validateSettings(req.body);
    if (!result.ok) return res.status(400).json({ error: 'invalid_input', issues: result.issues });
    res.json({ settings: await settings.save(result.settings) });
  });

  router.get('/overlay-url', (req, res) => {
    res.json({ url: `${config.baseUrl}/overlay?key=${encodeURIComponent(config.overlayKey)}`, width: 1920, height: 1080 });
  });

  router.post('/overlay/test', noInput, (req, res) => {
    events.publish({ type: 'test' });
    res.json({ ok: true });
  });

  router.get('/currency-images', async (req, res) => {
    res.json({ images: await listCurrencyImages() });
  });

  router.post('/streamer/revoke', noInput, async (req, res) => {
    await streamer.revoke();
    res.json({ ok: true });
  });

  return router;
}
