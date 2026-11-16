// Alles rund um den Kanal des Streamers: Kanal-ID, Freigabe (verschlüsseltes Refresh-Token),
// Access-Token im Arbeitsspeicher und die EventSub-Abos.
import { log } from '../log.js';
import { createTokenCipher } from '../security/crypto.js';
import { TwitchError } from '../twitch.js';

export const STREAMER_SCOPES = ['moderator:read:followers', 'moderator:read:chatters'];

export function createStreamer({ db, config, twitch, state }) {
  const cipher = createTokenCipher(config.tokenKeyHex);

  let channelId = null;
  let authorized = false;
  let access = null; // { token, expiresAt } – nur im Arbeitsspeicher
  let refreshing = null; // läuft gerade eine Erneuerung, warten alle auf dieselbe

  async function forget({ needsReconnect }) {
    access = null;
    authorized = false;
    await db('streamer_auth').del();
    await state.set('streamer_authorized', 'false');
    await state.set('streamer_needs_reconnect', needsReconnect ? 'true' : 'false');
  }

  async function saveRefreshToken(refreshToken, scopes) {
    const row = { id: 1, refresh_token_enc: cipher.encrypt(refreshToken), scopes: scopes.join(' '), updated_at: Date.now() };
    await db('streamer_auth').insert(row).onConflict('id').merge();
  }

  async function readRefreshToken() {
    const row = await db('streamer_auth').where({ id: 1 }).first();
    if (!row) return null;
    try {
      return { token: cipher.decrypt(row.refresh_token_enc), scopes: row.scopes.split(' ').filter(Boolean) };
    } catch {
      log.warn('Die gespeicherte Kanal-Verbindung konnte nicht gelesen werden. Bitte den Kanal unter /admin neu verbinden.');
      await forget({ needsReconnect: true });
      return null;
    }
  }

  async function renew() {
    const stored = await readRefreshToken();
    if (!stored) return null;
    let tokens;
    try {
      tokens = await twitch.refresh(stored.token);
    } catch (err) {
      if (err instanceof TwitchError && (err.status === 400 || err.status === 401)) {
        log.warn('Twitch hat die Kanal-Verbindung abgelehnt. Bitte den Kanal unter /admin neu verbinden.');
        await forget({ needsReconnect: true });
        return null;
      }
      throw err;
    }
    // Twitch kann ein neues Refresh-Token zurückgeben: sofort verschlüsselt speichern.
    if (tokens.refreshToken && tokens.refreshToken !== stored.token) {
      await saveRefreshToken(tokens.refreshToken, tokens.scopes.length ? tokens.scopes : stored.scopes);
    }
    access = { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresInMs - 60000 };
    return access.token;
  }

  /** Gültiges Access-Token des Streamers oder null, wenn keine Freigabe besteht. */
  async function getAccessToken({ forceNew = false } = {}) {
    if (!authorized) return null;
    if (access && !forceNew && Date.now() < access.expiresAt) return access.token;
    if (!refreshing) {
      refreshing = renew().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  const api = {
    async init() {
      authorized = (await state.get('streamer_authorized')) === 'true';
    },

    channelId: () => channelId,
    isAuthorized: () => authorized,

    /** Kanal-ID über den Kanalnamen auflösen (einmalig, bleibt im Speicher). */
    async resolveChannelId() {
      if (channelId) return channelId;
      const user = await twitch.getUserByLogin(config.channel);
      if (!user) throw new TwitchError('Kanal nicht gefunden');
      channelId = user.id;
      return channelId;
    },

    async ensureChannelId() {
      try {
        return await api.resolveChannelId();
      } catch {
        return null;
      }
    },

    isChannelUser: (twitchId) => Boolean(channelId) && twitchId === channelId,

    /** Nach erfolgreicher Streamer-Freigabe: Refresh-Token verschlüsselt speichern. */
    async connect(tokens) {
      if (!tokens.refreshToken) throw new TwitchError('Kein Refresh-Token erhalten');
      await saveRefreshToken(tokens.refreshToken, tokens.scopes);
      access = { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresInMs - 60000 };
      authorized = true;
      await state.set('streamer_authorized', 'true');
      await state.set('streamer_needs_reconnect', 'false');
      api.ensureEventSubs().catch((err) => log.error('EventSub-Abos konnten nicht angelegt werden', err));
    },

    /** Freigabe entfernen: Token bei Twitch widerrufen und alles Gespeicherte löschen. */
    async revoke() {
      let accessToken = null;
      try {
        accessToken = await getAccessToken();
      } catch (err) {
        log.error('Streamer-Token konnte vor dem Entfernen nicht erneuert werden', err);
      }
      const row = await db('streamer_auth').where({ id: 1 }).first();
      let refreshToken = null;
      if (row) {
        try {
          refreshToken = cipher.decrypt(row.refresh_token_enc);
        } catch {
          refreshToken = null;
        }
      }
      for (const token of [accessToken, refreshToken]) {
        if (!token) continue;
        try {
          await twitch.revoke(token);
        } catch (err) {
          log.error('Widerruf bei Twitch fehlgeschlagen', err);
        }
      }
      await forget({ needsReconnect: false });
    },

    async status() {
      const row = await db('streamer_auth').where({ id: 1 }).first('scopes');
      return {
        streamerAuthorized: authorized,
        streamerNeedsReconnect: (await state.get('streamer_needs_reconnect')) === 'true',
        streamerScopes: authorized && row ? row.scopes.split(' ').filter(Boolean) : [],
      };
    },

    /** Twitch-IDs aller Chatter oder null, wenn es gerade keine gültige Freigabe gibt. */
    async chatterIds() {
      if (!channelId) return null;
      let token = await getAccessToken();
      if (!token) return null;
      try {
        return await twitch.getChatterIds(channelId, token);
      } catch (err) {
        if (!(err instanceof TwitchError) || err.status !== 401) throw err;
        token = await getAccessToken({ forceNew: true });
        if (!token) return null;
        return twitch.getChatterIds(channelId, token);
      }
    },

    /** Fehlende EventSub-Abos anlegen. Nur online: Twitch erreicht localhost nicht. */
    async ensureEventSubs() {
      if (!config.isHttps) return;
      const id = await api.resolveChannelId();
      const callback = `${config.baseUrl}/webhooks/twitch`;
      const active = new Set(['enabled', 'webhook_callback_verification_pending']);
      const existing = new Set(
        (await twitch.listEventSubs())
          .filter((s) => s && active.has(s.status) && s.transport?.callback === callback && s.condition?.broadcaster_user_id === id)
          .map((s) => s.type),
      );
      const wanted = [
        { type: 'stream.online', version: '1', condition: { broadcaster_user_id: id } },
        { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: id } },
      ];
      if (authorized) wanted.push({ type: 'channel.follow', version: '2', condition: { broadcaster_user_id: id, moderator_user_id: id } });
      for (const sub of wanted) {
        if (existing.has(sub.type)) continue;
        await twitch.createEventSub(sub.type, sub.version, sub.condition);
        log.info(`EventSub-Abo angelegt: ${sub.type}`);
      }
    },
  };

  return api;
}
