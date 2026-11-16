// Die API für Zuschauer. Der Server entscheidet alles: Wer ist eingeloggt, was kostet es, läuft ein Cooldown.
import express from 'express';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { redeemLimiter } from '../security/ratelimits.js';
import { requireAuth } from '../security/sessions.js';
import { todayInBerlin } from '../services/bananas.js';

const emptySchema = z.strictObject({});
const redeemSchema = z.strictObject({
  actionId: z.string().min(1).max(50),
  option: z.string().min(1).max(100).optional(),
});

/** Prüft den Body gegen ein striktes Schema. Unbekannte Felder führen zu 400. */
export const validBody = (schema) => (req, res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return next(new HttpError(400, 'invalid_input'));
  req.input = parsed.data;
  next();
};
export const noInput = validBody(emptySchema);

export function apiRoutes({ settings, live, bananas, redeem, sessions, streamer }) {
  const router = express.Router();

  router.get('/config', (req, res) => {
    res.json({ ...settings.publicConfig(), isLive: live.isLive() });
  });

  router.get('/leaderboard', async (req, res) => {
    res.json(await bananas.leaderboard());
  });

  router.get('/vote', async (req, res) => {
    res.json(await redeem.voteTally());
  });

  router.get('/me', requireAuth, (req, res) => {
    const u = req.user;
    res.json({
      displayName: u.display_name,
      login: u.login,
      bananas: u.bananas,
      isLive: live.isLive(),
      checkedInToday: u.last_checkin_date === todayInBerlin(),
      isAdmin: streamer.isChannelUser(u.twitch_id),
      watchMinutes: u.watch_minutes,
    });
  });

  router.post('/checkin', requireAuth, noInput, async (req, res) => {
    res.json(await bananas.checkin(req.user));
  });

  router.post('/redeem', requireAuth, redeemLimiter(), validBody(redeemSchema), async (req, res) => {
    res.json(await redeem.redeem(req.user, req.input));
  });

  router.post('/me/delete', requireAuth, noInput, async (req, res) => {
    await bananas.deleteUser(req.user);
    sessions.clearCookie(res);
    res.json({ ok: true });
  });

  return router;
}
