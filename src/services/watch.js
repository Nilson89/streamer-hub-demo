// Zuschau-Belohnung: Einmal pro Minute wird geprüft, wer im Twitch-Chat ist.
// Gezählt werden nur Personen, die sich schon im Hub angemeldet haben. Alle anderen werden nicht gespeichert.
import { log } from '../log.js';

const CHUNK = 500;
const chunks = (list) => {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
};

export function createWatch({ db, config, settings, live, streamer }) {
  let running = false;

  async function run() {
    if (!live.isLive() || !streamer.isAuthorized() || settings.get().watchBananas <= 0) return;
    const channelId = streamer.channelId();
    if (!channelId) return;

    const chatters = await streamer.chatterIds();
    if (!chatters || !chatters.length) return;
    const candidates = [...new Set(chatters)].filter((id) => id !== channelId);

    // Nur wer schon in users steht, zählt. Unbekannte Chatter werden nirgends gespeichert.
    const present = [];
    for (const part of chunks(candidates)) {
      const rows = await db('users').whereIn('twitch_id', part).select('twitch_id');
      present.push(...rows.map((r) => r.twitch_id));
    }
    if (!present.length) return;

    for (const part of chunks(present)) {
      await db('users').whereIn('twitch_id', part).increment('watch_minutes', 1);
    }

    // Vor dem Gutschreiben noch einmal prüfen: Ist der Stream inzwischen offline, gibt es nichts.
    if (!live.isLive()) return;
    const { watchBananas, watchIntervalMinutes } = settings.get();
    if (watchBananas <= 0) return;

    const now = Date.now();
    for (const part of chunks(present)) {
      await db('users')
        .whereIn('twitch_id', part)
        .andWhere('watch_minutes', '>=', watchIntervalMinutes)
        .update({
          bananas: db.raw('?? + ?', ['bananas', watchBananas]),
          watch_minutes: db.raw('?? - ?', ['watch_minutes', watchIntervalMinutes]),
          updated_at: now,
        });
    }
    // Falls das Intervall auf der Admin-Seite verkleinert wurde: Zähler begrenzen.
    await db('users').where('watch_minutes', '>', watchIntervalMinutes).update({ watch_minutes: watchIntervalMinutes });
  }

  return {
    /** Ein Durchgang. Läuft der vorige noch, wird dieser übersprungen. Stürzt nie ab. */
    async tick() {
      if (running) return;
      running = true;
      try {
        await run();
      } catch (err) {
        log.error('Zuschau-Durchgang fehlgeschlagen, nächster Versuch in einer Minute', err);
      } finally {
        running = false;
      }
    },

    start() {
      const timer = setInterval(() => this.tick(), config.minuteMs);
      timer.unref();
      return timer;
    },
  };
}
