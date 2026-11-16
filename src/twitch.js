// Alle Aufrufe an Twitch (OAuth, Helix, EventSub).
// Tokens werden hier nur durchgereicht, nie geloggt und nie in Fehlermeldungen geschrieben.
const TIMEOUT_MS = 8000;

export class TwitchError extends Error {
  constructor(what, status = 0) {
    super(`Twitch-Aufruf fehlgeschlagen: ${what}${status ? ` (Status ${status})` : ' (nicht erreichbar)'}`);
    this.name = 'TwitchError';
    this.status = status;
  }
}

export function createTwitch(config) {
  const idUrl = config.twitchIdUrl;
  const apiUrl = config.twitchApiUrl;
  const redirectUri = `${config.baseUrl}/auth/callback`;

  let appToken = null; // nur im Arbeitsspeicher

  async function request(what, url, options) {
    let res;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new TwitchError(what);
    }
    return res;
  }

  async function readJson(what, res) {
    try {
      return await res.json();
    } catch {
      throw new TwitchError(what, res.status);
    }
  }

  async function tokenRequest(what, params) {
    const res = await request(what, `${idUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => {});
      throw new TwitchError(what, res.status);
    }
    const data = await readJson(what, res);
    if (!data || typeof data.access_token !== 'string' || !data.access_token) throw new TwitchError(what, res.status);
    return data;
  }

  const normalizeTokens = (data) => ({
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : null,
    expiresInMs: (Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : 3600) * 1000,
    scopes: Array.isArray(data.scope) ? data.scope.filter((s) => typeof s === 'string') : [],
  });

  async function getAppToken(forceNew = false) {
    if (appToken && !forceNew && Date.now() < appToken.expiresAt) return appToken.token;
    const data = await tokenRequest('App-Token holen', { grant_type: 'client_credentials' });
    const t = normalizeTokens(data);
    appToken = { token: t.accessToken, expiresAt: Date.now() + t.expiresInMs - 60000 };
    return appToken.token;
  }

  async function helix(what, pathAndQuery, token, { method = 'GET', body } = {}) {
    const headers = { authorization: `Bearer ${token}`, 'client-id': config.clientId };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return request(what, `${apiUrl}/helix/${pathAndQuery}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  }

  /** Helix-Aufruf mit App-Token. Bei 401 wird einmal ein neues Token geholt. */
  async function helixApp(what, pathAndQuery, options) {
    let res = await helix(what, pathAndQuery, await getAppToken(), options);
    if (res.status === 401) {
      await res.arrayBuffer().catch(() => {});
      res = await helix(what, pathAndQuery, await getAppToken(true), options);
    }
    return res;
  }

  const toUser = (u) => {
    if (!u || typeof u.id !== 'string' || typeof u.login !== 'string') return null;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(u.id) || !u.login || u.login.length > 64) return null;
    const displayName = typeof u.display_name === 'string' && u.display_name ? u.display_name : u.login;
    return { id: u.id, login: u.login, displayName: displayName.slice(0, 100) };
  };

  return {
    authorizeUrl(state, scope) {
      const url = new URL(`${idUrl}/oauth2/authorize`);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', scope);
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchangeCode(code) {
      const data = await tokenRequest('Login-Code eintauschen', { code, grant_type: 'authorization_code', redirect_uri: redirectUri });
      return normalizeTokens(data);
    },

    async refresh(refreshToken) {
      const data = await tokenRequest('Streamer-Token erneuern', { grant_type: 'refresh_token', refresh_token: refreshToken });
      return normalizeTokens(data);
    },

    /** Token bei Twitch widerrufen. Gibt true zurück, wenn Twitch den Widerruf bestätigt hat. */
    async revoke(token) {
      const res = await request('Token widerrufen', `${idUrl}/oauth2/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, token }),
      });
      await res.arrayBuffer().catch(() => {});
      return res.ok;
    },

    /** Wer gehört zu diesem Token? Liefert nur id, login und displayName. */
    async getUserByToken(accessToken) {
      const what = 'Benutzer abfragen';
      const res = await helix(what, 'users', accessToken);
      if (!res.ok) {
        await res.arrayBuffer().catch(() => {});
        throw new TwitchError(what, res.status);
      }
      const data = await readJson(what, res);
      const user = toUser(data?.data?.[0]);
      if (!user) throw new TwitchError(what, res.status);
      return user;
    },

    async getUserByLogin(login) {
      const what = 'Kanal-ID auflösen';
      const res = await helixApp(what, `users?${new URLSearchParams({ login })}`);
      if (!res.ok) {
        await res.arrayBuffer().catch(() => {});
        throw new TwitchError(what, res.status);
      }
      const data = await readJson(what, res);
      return toUser(data?.data?.[0]);
    },

    async isStreamLive(channelId) {
      const what = 'Live-Status abfragen';
      const res = await helixApp(what, `streams?${new URLSearchParams({ user_id: channelId })}`);
      if (!res.ok) {
        await res.arrayBuffer().catch(() => {});
        throw new TwitchError(what, res.status);
      }
      const data = await readJson(what, res);
      return Array.isArray(data?.data) && data.data.length > 0;
    },

    /** Twitch-IDs aller Chatter. Braucht das Access-Token des Streamers. */
    async getChatterIds(channelId, streamerToken) {
      const what = 'Chatter-Liste abfragen';
      const ids = [];
      let cursor = null;
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ broadcaster_id: channelId, moderator_id: channelId, first: '1000' });
        if (cursor) query.set('after', cursor);
        const res = await helix(what, `chat/chatters?${query}`, streamerToken);
        if (!res.ok) {
          await res.arrayBuffer().catch(() => {});
          throw new TwitchError(what, res.status);
        }
        const data = await readJson(what, res);
        for (const c of Array.isArray(data?.data) ? data.data : []) {
          if (typeof c?.user_id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(c.user_id)) ids.push(c.user_id);
        }
        cursor = typeof data?.pagination?.cursor === 'string' && data.pagination.cursor ? data.pagination.cursor : null;
        if (!cursor) break;
      }
      return ids;
    },

    async listEventSubs() {
      const what = 'EventSub-Abos abfragen';
      const subs = [];
      let cursor = null;
      for (let page = 0; page < 20; page++) {
        const res = await helixApp(what, `eventsub/subscriptions${cursor ? `?${new URLSearchParams({ after: cursor })}` : ''}`);
        if (!res.ok) {
          await res.arrayBuffer().catch(() => {});
          throw new TwitchError(what, res.status);
        }
        const data = await readJson(what, res);
        if (Array.isArray(data?.data)) subs.push(...data.data);
        cursor = typeof data?.pagination?.cursor === 'string' && data.pagination.cursor ? data.pagination.cursor : null;
        if (!cursor) break;
      }
      return subs;
    },

    async createEventSub(type, version, condition) {
      const what = `EventSub-Abo ${type} anlegen`;
      const res = await helixApp(what, 'eventsub/subscriptions', {
        method: 'POST',
        body: {
          type,
          version,
          condition,
          transport: { method: 'webhook', callback: `${config.baseUrl}/webhooks/twitch`, secret: config.eventsubSecret },
        },
      });
      await res.arrayBuffer().catch(() => {});
      // 409 heißt: Das Abo gibt es schon. Das ist in Ordnung.
      if (!res.ok && res.status !== 409) throw new TwitchError(what, res.status);
    },
  };
}
