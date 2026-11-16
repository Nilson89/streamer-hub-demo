// Einstiegspunkt: Konfiguration prüfen, Datenbank vorbereiten, Twitch-Daten laden, dann den Port öffnen.
import { createApp, createSetupApp } from './app.js';
import { SetupProblem, loadConfig, secretValues } from './config.js';
import { createDb, createState, migrate } from './db.js';
import { log, setLogSecrets } from './log.js';
import { createSessions } from './security/sessions.js';
import { createBananas } from './services/bananas.js';
import { createEvents } from './services/events.js';
import { createLive } from './services/live.js';
import { createRedeem } from './services/redeem.js';
import { createSettings } from './services/settings.js';
import { createStreamer } from './services/streamer.js';
import { createWatch } from './services/watch.js';
import { createTwitch } from './twitch.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function every(ms, label, job) {
  const timer = setInterval(() => {
    job().catch((err) => log.error(`${label} fehlgeschlagen`, err));
  }, ms);
  timer.unref();
  return timer;
}

function listen(app, port, onClose) {
  const server = app.listen(port);
  server.on('error', (err) => {
    log.error(err.code === 'EADDRINUSE' ? `Port ${port} ist schon belegt. Läuft die App bereits?` : 'Der Server konnte nicht starten', err);
    process.exit(1);
  });
  const shutdown = () => {
    server.close();
    server.closeAllConnections?.();
    Promise.resolve(onClose?.())
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return new Promise((resolve) => server.once('listening', resolve));
}

/** Setup-Modus: Die App stürzt nicht ab, sondern erklärt auf der Startseite, was fehlt (nur Namen, nie Werte). */
async function startSetup(port, problems) {
  await listen(createSetupApp(problems), port);
  log.warn(`Setup-Modus auf Port ${port}. Es fehlt noch: ${problems.map((p) => `${p.name} (${p.kind})`).join(', ')}`);
}

async function main() {
  const { config, problems } = loadConfig();
  setLogSecrets(secretValues(config));
  if (problems.length) return startSetup(config.port, problems);

  // Datenbank
  let db;
  try {
    db = createDb(config);
    await migrate(db);
  } catch (err) {
    log.error('Die Datenbank ist nicht erreichbar oder konnte nicht vorbereitet werden', { name: err?.name, code: err?.code });
    await db?.destroy().catch(() => {});
    return startSetup(config.port, [{ name: 'DATABASE_URL', kind: 'ungültig' }]);
  }

  // Einstellungen (beim ersten Start aus hub.config.json)
  const state = createState(db);
  const settings = createSettings({ db, config, state });
  try {
    await settings.init();
  } catch (err) {
    if (!(err instanceof SetupProblem)) throw err;
    await db.destroy().catch(() => {});
    return startSetup(config.port, [err.problem]);
  }

  const twitch = createTwitch(config);
  const events = createEvents();
  const sessions = createSessions({ db, config });
  const streamer = createStreamer({ db, config, twitch, state });
  const live = createLive({ config, twitch, state, streamer });
  const bananas = createBananas({ db, settings, live, events });
  const redeem = createRedeem({ db, settings, events, state });
  const watch = createWatch({ db, config, settings, live, streamer });
  await streamer.init();
  await live.init();

  // Kanal-ID und Live-Status laden: höchstens 10 Sekunden warten, sonst im Hintergrund weiter versuchen.
  const loadTwitchData = async () => {
    await streamer.resolveChannelId();
    await live.poll();
  };
  const afterTwitchReady = () => {
    streamer.ensureEventSubs().catch((err) => log.error('EventSub-Abos konnten nicht abgeglichen werden', err));
  };
  const first = await Promise.race([
    loadTwitchData().then(
      () => 'ok',
      (err) => {
        log.error('Twitch-Daten konnten beim Start nicht geladen werden', err);
        return 'failed';
      },
    ),
    sleep(10000).then(() => 'timeout'),
  ]);
  if (first === 'ok') {
    afterTwitchReady();
  } else {
    const retry = setInterval(() => {
      loadTwitchData().then(
        () => {
          clearInterval(retry);
          log.info('Twitch-Daten nachgeladen.');
          afterTwitchReady();
        },
        () => {},
      );
    }, 30000);
    retry.unref();
  }

  const app = createApp({ config, db, state, settings, twitch, events, sessions, streamer, live, bananas, redeem });
  await listen(app, config.port, () => db.destroy());
  log.info(`Der Hub läuft: ${config.baseUrl} (Port ${config.port})`);
  if (config.devAlwaysLive) log.info('DEV_ALWAYS_LIVE ist an: Der Stream gilt lokal immer als live.');

  // Regelmäßige Aufgaben
  watch.start();
  every(5 * 60 * 1000, 'Live-Status-Abfrage', () => live.poll());
  every(30 * 60 * 1000, 'EventSub-Abgleich', () => streamer.ensureEventSubs());
  every(10 * 60 * 1000, 'Aufräumen', async () => {
    await sessions.cleanup();
    await db('eventsub_messages')
      .where('received_at', '<', Date.now() - 60 * 60 * 1000)
      .del();
  });
}

process.on('unhandledRejection', (err) => {
  log.error('Unerwarteter Fehler im Hintergrund', err);
});

main().catch((err) => {
  log.error('Die App konnte nicht starten', err);
  process.exit(1);
});
