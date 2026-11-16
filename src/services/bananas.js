// Regeln für die virtuelle Währung: Benutzer anlegen, Check-in, Follow-Bonus, Rangliste, Daten löschen.
// Der Kontostand ändert sich nur hier und in redeem.js/watch.js, immer atomar in der Datenbank.
import { HttpError } from '../errors.js';

const berlinDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Heutiges Datum in Deutschland als YYYY-MM-DD. */
export const todayInBerlin = () => berlinDay.format(new Date());

export function createBananas({ db, settings, live, events }) {
  async function upsertOnce(twitchUser) {
    return db.transaction(async (trx) => {
      const now = Date.now();
      const existing = await trx('users').where({ twitch_id: twitchUser.id }).forUpdate().first();
      if (existing) {
        await trx('users').where({ id: existing.id }).update({ login: twitchUser.login, display_name: twitchUser.displayName, updated_at: now });
      } else {
        await trx('users').insert({
          twitch_id: twitchUser.id,
          login: twitchUser.login,
          display_name: twitchUser.displayName,
          bananas: 0,
          watch_minutes: 0,
          follow_bonus_granted: false,
          last_checkin_date: null,
          created_at: now,
          updated_at: now,
        });
      }
      const user = await trx('users').where({ twitch_id: twitchUser.id }).first();

      // Hat die Person schon vor dem ersten Login gefolgt? Dann gibt es den Bonus jetzt.
      let granted = null;
      if (!user.follow_bonus_granted) {
        const marked = await trx('follows').where({ twitch_id: twitchUser.id, bonus_granted: false }).update({ bonus_granted: true });
        if (marked === 1) {
          const amount = settings.get().followBonus;
          await trx('users')
            .where({ id: user.id })
            .update({ bananas: trx.raw('?? + ?', ['bananas', amount]), follow_bonus_granted: true, updated_at: now });
          granted = amount;
        }
      }
      return { user, granted };
    });
  }

  return {
    /** Legt den Benutzer nach dem Login an oder aktualisiert Namen. Gibt die Datenbankzeile zurück. */
    async upsertUser(twitchUser) {
      let result;
      try {
        result = await upsertOnce(twitchUser);
      } catch {
        // Zwei gleichzeitige erste Logins derselben Person: einfach noch einmal versuchen.
        result = await upsertOnce(twitchUser);
      }
      if (result.granted !== null) {
        events.publish({ type: 'follow', displayName: result.user.display_name, amount: result.granted });
      }
      return result.user;
    },

    /** Check-in: einmal pro Kalendertag (Europe/Berlin) und nur, wenn der Stream live ist. */
    async checkin(user) {
      if (!live.isLive()) throw new HttpError(409, 'not_live');
      const today = todayInBerlin();
      const amount = settings.get().checkinBananas;
      const changed = await db('users')
        .where({ id: user.id })
        .andWhere((q) => q.whereNull('last_checkin_date').orWhere('last_checkin_date', '<>', today))
        .update({ bananas: db.raw('?? + ?', ['bananas', amount]), last_checkin_date: today, updated_at: Date.now() });
      if (changed !== 1) throw new HttpError(409, 'already_checked_in');
      const row = await db('users').where({ id: user.id }).first('bananas');
      return { bananas: row.bananas };
    },

    /** Follow-Meldung von Twitch: Bonus einmal pro Twitch-Account, sonst für den ersten Login vormerken. */
    async handleFollow(event) {
      const twitchId = event?.user_id;
      if (typeof twitchId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(twitchId)) return;
      const granted = await db.transaction(async (trx) => {
        const now = Date.now();
        const user = await trx('users').where({ twitch_id: twitchId }).forUpdate().first();
        const follow = await trx('follows').where({ twitch_id: twitchId }).first();
        if (!user) {
          if (!follow) await trx('follows').insert({ twitch_id: twitchId, bonus_granted: false, created_at: now });
          return null;
        }
        if (follow?.bonus_granted) return null;
        const amount = settings.get().followBonus;
        const changed = await trx('users')
          .where({ id: user.id, follow_bonus_granted: false })
          .update({ bananas: trx.raw('?? + ?', ['bananas', amount]), follow_bonus_granted: true, updated_at: now });
        if (follow) await trx('follows').where({ twitch_id: twitchId }).update({ bonus_granted: true });
        else await trx('follows').insert({ twitch_id: twitchId, bonus_granted: true, created_at: now });
        return changed === 1 ? { displayName: user.display_name, amount } : null;
      });
      if (granted) events.publish({ type: 'follow', ...granted });
    },

    async leaderboard() {
      const rows = await db('users')
        .where('bananas', '>', 0)
        .orderBy([
          { column: 'bananas', order: 'desc' },
          { column: 'display_name', order: 'asc' },
        ])
        .limit(settings.get().leaderboardSize)
        .select('display_name', 'bananas');
      return { entries: rows.map((r) => ({ displayName: r.display_name, bananas: r.bananas })) };
    },

    /** Löscht alles zu dieser Person: Sessions, Einlösungen, Follow-Vermerk und den Benutzer selbst. */
    async deleteUser(user) {
      await db.transaction(async (trx) => {
        await trx('sessions').where({ user_id: user.id }).del();
        await trx('redemptions').where({ user_id: user.id }).del();
        await trx('follows').where({ twitch_id: user.twitch_id }).del();
        await trx('users').where({ id: user.id }).del();
      });
    },
  };
}
