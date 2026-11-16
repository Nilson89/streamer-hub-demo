// Live-Status des Streams. Quelle: Twitch-Abfrage alle 5 Minuten plus Webhooks (sofort).
import { log } from '../log.js';

const WEBHOOK_GRACE_MS = 3 * 60 * 1000;

export function createLive({ config, twitch, state, streamer }) {
  let live = false;
  let lastOnlineWebhookAt = 0;

  async function set(next) {
    if (next === live) return;
    live = next;
    await state.set('stream_live', next ? 'true' : 'false');
    if (next) {
      await state.set('stream_started_at', Date.now());
    } else {
      // Stream vorbei: Die laufende Abstimmung beginnt beim nächsten Mal von vorn.
      await state.set('vote_reset_at', Date.now());
    }
    log.info(next ? 'Der Stream ist live.' : 'Der Stream ist offline.');
  }

  return {
    async init() {
      live = (await state.get('stream_live')) === 'true';
    },

    /** DEV_ALWAYS_LIVE wirkt nur lokal (siehe config.js). */
    isLive: () => config.devAlwaysLive || live,

    /** Vom Webhook: Status sofort setzen. */
    async fromWebhook(next) {
      if (next) lastOnlineWebhookAt = Date.now();
      await set(next);
    },

    /** Regelmäßige Abfrage bei Twitch. */
    async poll() {
      const channelId = await streamer.resolveChannelId();
      const next = await twitch.isStreamLive(channelId);
      // Direkt nach „Stream gestartet“ hinkt die Twitch-Abfrage manchmal kurz hinterher.
      if (!next && live && Date.now() - lastOnlineWebhookAt < WEBHOOK_GRACE_MS) return;
      await set(next);
    },
  };
}
