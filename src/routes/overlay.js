// OBS-Overlay: nur mit dem geheimen Schlüssel erreichbar. Der Schlüssel wird nie geloggt.
import path from 'node:path';
import express from 'express';
import { VIEWS_DIR } from '../config.js';
import { safeEqual } from '../security/crypto.js';

export function overlayRoutes({ config, settings, events }) {
  const router = express.Router();

  // Schlüssel auf dem Server prüfen: beide Werte hashen, dann zeitkonstant vergleichen.
  router.use((req, res, next) => {
    const key = req.query.key;
    res.set('Cache-Control', 'no-store');
    if (typeof key !== 'string' || key.length > 512 || !safeEqual(key, config.overlayKey)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  });

  router.get('/', (req, res) => {
    res.sendFile(path.join(VIEWS_DIR, 'overlay.html'));
  });

  router.get('/config', (req, res) => {
    const s = settings.get();
    res.json({ currencyName: s.currencyName, currencyEmoji: s.currencyEmoji, currencyImage: s.currencyImage, followBonus: s.followBonus });
  });

  router.get('/events', (req, res) => {
    if (!events.subscribe(req, res)) res.status(503).json({ error: 'too_many_connections' });
  });

  return router;
}
