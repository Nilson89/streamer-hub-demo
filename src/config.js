// Lädt und prüft die Umgebungsvariablen und die Startwerte aus hub.config.json.
// Wichtig: Diese Datei liest NIE eine .env-Datei. Die Variablen kommen von außen
// (lokal über `npm run dev`, online über Hostinger).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const VIEWS_DIR = path.join(ROOT, 'views');
export const CURRENCY_DIR = path.join(PUBLIC_DIR, 'waehrung');

/** Ein Problem, das die App in den Setup-Modus schickt. Enthält nur Namen, nie Werte. */
export class SetupProblem extends Error {
  constructor(name, kind) {
    super(`${name} ${kind}`);
    this.problem = { name, kind };
  }
}

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Prüft alle Umgebungsvariablen.
 * Gibt die Konfiguration und eine Liste der Probleme zurück (nur Namen, keine Werte).
 */
export function loadConfig(env = process.env) {
  const problems = [];
  const missing = (name) => problems.push({ name, kind: 'fehlt' });
  const invalid = (name) => problems.push({ name, kind: 'ungültig' });

  // NODE_ENV
  let nodeEnv = clean(env.NODE_ENV) || 'development';
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    invalid('NODE_ENV');
    nodeEnv = 'production'; // im Zweifel die strengere Variante
  }
  const isProd = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  // PORT
  let port = 3000;
  if (clean(env.PORT)) {
    const p = Number(clean(env.PORT));
    if (Number.isInteger(p) && p >= 1 && p <= 65535) port = p;
    else invalid('PORT');
  }

  // BASE_URL
  let baseUrl = clean(env.BASE_URL).replace(/\/+$/, '');
  let baseOrigin = '';
  let baseHost = '';
  let isHttps = false;
  if (!baseUrl) {
    if (isProd) missing('BASE_URL');
    else baseUrl = `http://localhost:${port}`;
  }
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      const plainAddress = (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash && !u.username && !u.password;
      if (!['http:', 'https:'].includes(u.protocol) || !plainAddress) throw new Error('unbrauchbar');
      if (isProd && u.protocol !== 'https:') throw new Error('online nur https');
      baseOrigin = u.origin;
      baseHost = u.hostname;
      isHttps = u.protocol === 'https:';
      baseUrl = u.origin;
    } catch {
      invalid('BASE_URL');
    }
  }

  // Twitch-App
  const clientId = clean(env.TWITCH_CLIENT_ID);
  if (!clientId) missing('TWITCH_CLIENT_ID');
  const clientSecret = clean(env.TWITCH_CLIENT_SECRET);
  if (!clientSecret) missing('TWITCH_CLIENT_SECRET');

  const channel = clean(env.TWITCH_CHANNEL).toLowerCase();
  if (!channel) missing('TWITCH_CHANNEL');
  else if (!/^[a-z0-9_]{1,25}$/.test(channel)) invalid('TWITCH_CHANNEL');

  const eventsubSecret = clean(env.EVENTSUB_SECRET);
  if (!eventsubSecret) missing('EVENTSUB_SECRET');
  else if (eventsubSecret.length < 10 || eventsubSecret.length > 100) invalid('EVENTSUB_SECRET');

  const overlayKey = clean(env.OVERLAY_KEY);
  if (!overlayKey) missing('OVERLAY_KEY');
  else if (overlayKey.length < 32) invalid('OVERLAY_KEY');

  const tokenKeyHex = clean(env.TOKEN_ENCRYPTION_KEY);
  if (!tokenKeyHex) missing('TOKEN_ENCRYPTION_KEY');
  else if (!/^[0-9a-fA-F]{64}$/.test(tokenKeyHex)) invalid('TOKEN_ENCRYPTION_KEY');

  // Datenbank
  let databaseUrl = clean(env.DATABASE_URL);
  let database = null;
  if (!databaseUrl) {
    if (isProd) missing('DATABASE_URL');
    else databaseUrl = 'file:./data/hub.sqlite';
  }
  if (databaseUrl) {
    if (databaseUrl.startsWith('file:')) {
      // Bewusst per String abgeschnitten und nicht mit new URL(): Windows-Pfade wie file:C:/… gehen sonst kaputt.
      const rest = databaseUrl.slice('file:'.length);
      if (!rest) invalid('DATABASE_URL');
      else database = { kind: 'sqlite', filename: path.isAbsolute(rest) ? rest : path.resolve(ROOT, rest) };
    } else if (databaseUrl.startsWith('mysql://')) {
      try {
        const u = new URL(databaseUrl);
        const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
        if (!u.hostname || !name) throw new Error('unvollständig');
        database = {
          kind: 'mysql',
          host: u.hostname,
          port: u.port ? Number(u.port) : 3306,
          user: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password),
          database: name,
        };
      } catch {
        invalid('DATABASE_URL');
      }
    } else {
      invalid('DATABASE_URL');
    }
  }

  // Nur lokal: Stream gilt immer als live
  const devAlwaysLive =
    clean(env.DEV_ALWAYS_LIVE).toLowerCase() === 'true' && !isHttps && ['localhost', '127.0.0.1'].includes(baseHost);

  // Test-Schalter: werden außerhalb von NODE_ENV=test komplett ignoriert
  let twitchIdUrl = 'https://id.twitch.tv';
  let twitchApiUrl = 'https://api.twitch.tv';
  let minuteMs = 60000;
  let configFile = 'hub.config.json';
  if (isTest) {
    if (clean(env.TWITCH_ID_URL)) twitchIdUrl = clean(env.TWITCH_ID_URL).replace(/\/+$/, '');
    if (clean(env.TWITCH_API_URL)) twitchApiUrl = clean(env.TWITCH_API_URL).replace(/\/+$/, '');
    const m = Number(clean(env.HUB_MINUTE_MS));
    if (Number.isInteger(m) && m >= 50) minuteMs = m;
    if (clean(env.HUB_CONFIG_FILE)) configFile = clean(env.HUB_CONFIG_FILE);
  }

  const config = {
    nodeEnv,
    isProd,
    isTest,
    port,
    baseUrl,
    baseOrigin,
    isHttps,
    clientId,
    clientSecret,
    channel,
    eventsubSecret,
    overlayKey,
    tokenKeyHex,
    database,
    devAlwaysLive,
    twitchIdUrl,
    twitchApiUrl,
    minuteMs,
    configFile,
  };
  return { config, problems };
}

/** Alle geheimen Werte, damit der Logger sie notfalls unkenntlich machen kann. */
export function secretValues(config) {
  return [config.clientSecret, config.eventsubSecret, config.overlayKey, config.tokenKeyHex, config.database?.password].filter(
    (v) => typeof v === 'string' && v.length >= 6,
  );
}

/** Liest die Startwerte aus hub.config.json (nur beim allerersten Start nötig). */
export function readStartSettings(config) {
  const file = path.resolve(ROOT, config.configFile);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new SetupProblem('hub.config.json', 'ungültig');
  }
}
