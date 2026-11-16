// Login mit Twitch: Zuschauer-Login, Streamer-Freigabe, Rückkehr von Twitch, Logout.
import express from 'express';
import { log } from '../log.js';
import { messagePage } from '../pages.js';
import { randomId, safeEqual } from '../security/crypto.js';
import { parseCookies } from '../security/sessions.js';
import { STREAMER_SCOPES } from '../services/streamer.js';
import { TwitchError } from '../twitch.js';

const STATE_COOKIE = 'hub_oauth_state';
const FLOWS = { viewer: '', streamer: STREAMER_SCOPES.join(' ') };

const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

export function authRoutes({ config, twitch, sessions, bananas, streamer }) {
  const router = express.Router();
  const stateCookieOptions = { httpOnly: true, sameSite: 'lax', path: '/auth', secure: config.isHttps };

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const fail = (res, status, title, text) => res.status(status).type('html').send(messagePage({ title, text }));

  const start = (flow) => (req, res) => {
    const state = randomId();
    res.cookie(STATE_COOKIE, `${flow}.${state}`, { ...stateCookieOptions, maxAge: 600 * 1000 });
    res.redirect(302, twitch.authorizeUrl(state, FLOWS[flow]));
  };

  // Zuschauer geben keine zusätzlichen Rechte frei.
  router.get('/login', start('viewer'));
  // Der Streamer gibt genau zwei Rechte frei: Follower lesen und Chatter lesen.
  router.get('/streamer', start('streamer'));

  /** Token wegwerfen: bei Twitch widerrufen, damit es nirgends mehr gültig ist. */
  async function discard(tokens) {
    try {
      const ok = await twitch.revoke(tokens.accessToken);
      if (!ok) log.warn('Twitch hat den Token-Widerruf nach dem Login nicht bestätigt.');
    } catch (err) {
      log.error('Token-Widerruf nach dem Login fehlgeschlagen', err);
    }
    if (tokens.refreshToken) {
      try {
        await twitch.revoke(tokens.refreshToken);
      } catch {
        /* Das Access-Token ist bereits widerrufen. */
      }
    }
  }

  router.get('/callback', async (req, res) => {
    const stateCookie = parseCookies(req.headers.cookie)[STATE_COOKIE];
    // Der state ist nur einmal verwendbar: Cookie sofort löschen.
    res.clearCookie(STATE_COOKIE, stateCookieOptions);

    const { code, state } = req.query;
    if (req.query.error !== undefined) {
      return fail(res, 400, 'Anmeldung abgebrochen', 'Die Anmeldung über Twitch wurde nicht abgeschlossen. Du kannst es jederzeit noch einmal versuchen.');
    }
    if (!isText(code, 512) || !isText(state, 200)) {
      return fail(res, 400, 'Anmeldung fehlgeschlagen', 'Die Antwort von Twitch war unvollständig. Bitte starte die Anmeldung noch einmal.');
    }
    const dot = typeof stateCookie === 'string' ? stateCookie.indexOf('.') : -1;
    const flow = dot > 0 ? stateCookie.slice(0, dot) : '';
    const expected = dot > 0 ? stateCookie.slice(dot + 1) : '';
    if (!Object.hasOwn(FLOWS, flow) || !expected || !safeEqual(expected, state)) {
      return fail(res, 403, 'Anmeldung abgelehnt', 'Diese Anmeldung konnte nicht zugeordnet werden. Bitte starte sie noch einmal von der Startseite aus.');
    }

    // Code gegen Token tauschen
    let tokens;
    try {
      tokens = await twitch.exchangeCode(code);
    } catch (err) {
      const rejected = err instanceof TwitchError && err.status >= 400 && err.status < 500;
      log.warn(`Login: Twitch hat den Code nicht angenommen (Status ${err instanceof TwitchError ? err.status : 0}).`);
      return fail(res, rejected ? 400 : 502, 'Anmeldung fehlgeschlagen', 'Twitch hat die Anmeldung nicht bestätigt. Bitte versuche es noch einmal.');
    }

    // Wer ist das?
    let twitchUser;
    try {
      twitchUser = await twitch.getUserByToken(tokens.accessToken);
    } catch (err) {
      await discard(tokens);
      log.error('Login: Benutzer konnte nicht abgefragt werden', err);
      return fail(res, 502, 'Anmeldung fehlgeschlagen', 'Twitch ist gerade nicht erreichbar. Bitte versuche es gleich noch einmal.');
    }

    const channelId = await streamer.ensureChannelId();

    if (flow === 'streamer') {
      if (!channelId) {
        await discard(tokens);
        return fail(res, 503, 'Kanal noch nicht bereit', 'Der Kanal konnte bei Twitch noch nicht gefunden werden. Bitte versuche es in einer Minute noch einmal.');
      }
      // Nur der Streamer selbst darf seinen Kanal verbinden.
      if (twitchUser.id !== channelId) {
        await discard(tokens);
        return fail(res, 403, 'Kein Zugriff', 'Nur der Streamer dieses Kanals kann den Kanal verbinden und die Admin-Seite öffnen.');
      }
      const granted = new Set(tokens.scopes);
      if (!tokens.refreshToken || !STREAMER_SCOPES.every((s) => granted.has(s))) {
        await discard(tokens);
        return fail(res, 400, 'Freigabe unvollständig', 'Twitch hat nicht alle nötigen Rechte bestätigt. Bitte verbinde den Kanal noch einmal.');
      }
      await streamer.connect(tokens);
    } else {
      // Zuschauer: Das Token wird nur zum Abfragen der Identität gebraucht und sofort vernichtet.
      // Ausnahme Streamer: Ein Widerruf könnte seine gespeicherte Kanal-Verbindung zerstören,
      // deshalb wird sein Token hier nur verworfen (es läuft von selbst ab).
      const isStreamer = channelId ? twitchUser.id === channelId : twitchUser.login.toLowerCase() === config.channel;
      if (!isStreamer) await discard(tokens);
    }
    tokens = null;

    const user = await bananas.upsertUser(twitchUser);

    // Immer eine neue Session: Eine mitgeschickte alte (oder untergeschobene) wird vorher gelöscht.
    await sessions.drop(req);
    await sessions.start(res, user.id);
    res.redirect(302, flow === 'streamer' ? '/admin' : '/');
  });

  router.post('/logout', async (req, res) => {
    await sessions.destroy(req, res);
    res.status(200).json({ ok: true });
  });

  return router;
}
