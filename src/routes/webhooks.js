// Eingehende Twitch-Webhooks (EventSub). Der Schutz dieser Route ist die Signatur:
// Nur Twitch kennt EVENTSUB_SECRET und kann gültig unterschreiben.
import crypto from 'node:crypto';
import express from 'express';
import { log } from '../log.js';
import { safeEqual } from '../security/crypto.js';

const MAX_AGE_MS = 10 * 60 * 1000;
const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

export function webhookRoutes({ config, db, live, bananas, streamer }) {
  const router = express.Router();

  async function handleNotification(payload) {
    const type = payload?.subscription?.type;
    const event = payload?.event;
    if (!event || typeof event !== 'object') return;
    // Gehört das Ereignis wirklich zu unserem Kanal? Fremde Kanäle werden ignoriert.
    const channelId = await streamer.resolveChannelId();
    if (event.broadcaster_user_id !== channelId) return;
    if (type === 'stream.online') await live.fromWebhook(true);
    else if (type === 'stream.offline') await live.fromWebhook(false);
    else if (type === 'channel.follow') await bananas.handleFollow(event);
  }

  // Wichtig: roher Body, damit die Signatur über genau die empfangenen Bytes geprüft wird.
  router.post('/twitch', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
    const messageId = req.get('Twitch-Eventsub-Message-Id');
    const timestamp = req.get('Twitch-Eventsub-Message-Timestamp');
    const signature = req.get('Twitch-Eventsub-Message-Signature');
    const body = req.body;

    // 1. Signatur prüfen (HMAC-SHA256 über ID + Zeitstempel + rohen Body, zeitkonstanter Vergleich)
    if (!isText(messageId, 128) || !isText(timestamp, 64) || !isText(signature, 200) || !Buffer.isBuffer(body)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const expected = 'sha256=' + crypto.createHmac('sha256', config.eventsubSecret).update(messageId).update(timestamp).update(body).digest('hex');
    if (!safeEqual(expected, signature)) return res.status(403).json({ error: 'forbidden' });

    // 2. Zu alte Nachrichten (oder solche aus der Zukunft) ablehnen
    const sentAt = Date.parse(timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > MAX_AGE_MS) return res.status(403).json({ error: 'forbidden' });

    // 3. JSON lesen
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'bad_request' });
    }
    if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'bad_request' });

    // 4. Schon verarbeitet? Dann nichts weiter tun (Schutz vor Wiederholung).
    if (await db('eventsub_messages').where({ message_id: messageId }).first()) return res.status(204).end();
    try {
      await db('eventsub_messages').insert({ message_id: messageId, received_at: Date.now() });
    } catch (err) {
      if (await db('eventsub_messages').where({ message_id: messageId }).first()) return res.status(204).end();
      throw err;
    }

    const messageType = req.get('Twitch-Eventsub-Message-Type');
    if (messageType === 'webhook_callback_verification') {
      if (!isText(payload.challenge, 500)) return res.status(400).json({ error: 'bad_request' });
      return res.status(200).type('text/plain').send(payload.challenge);
    }
    if (messageType === 'revocation') {
      log.warn('Twitch hat ein EventSub-Abo beendet. Es wird beim nächsten Abgleich neu angelegt.');
      return res.status(204).end();
    }
    if (messageType === 'notification') {
      try {
        await handleNotification(payload);
      } catch (err) {
        // Nachricht wieder freigeben, damit Twitch es erneut versuchen kann.
        await db('eventsub_messages').where({ message_id: messageId }).del().catch(() => {});
        log.error('Webhook konnte nicht verarbeitet werden', err);
        return res.status(500).json({ error: 'internal_error' });
      }
    }
    res.status(204).end();
  });

  return router;
}
