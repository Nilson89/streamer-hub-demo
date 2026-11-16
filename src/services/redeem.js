// Aktionen einlösen und Abstimmung auszählen.
// Die Kosten kommen immer aus den Einstellungen auf dem Server, nie aus der Anfrage.
import { HttpError } from '../errors.js';

export function createRedeem({ db, settings, events, state }) {
  /** Stand der laufenden Abstimmung (erste Aktion vom Typ „vote“). */
  async function voteTally() {
    const action = settings.voteAction();
    if (!action) return { actionId: null, options: [] };
    const since = Number(await state.get('vote_reset_at')) || 0;
    const rows = await db('redemptions')
      .where({ action_id: action.id })
      .andWhere('created_at', '>=', since)
      .groupBy('option')
      .select('option')
      .count({ votes: '*' });
    const counts = new Map(rows.map((r) => [r.option, Number(r.votes)]));
    return { actionId: action.id, options: action.options.map((option) => ({ option, votes: counts.get(option) || 0 })) };
  }

  return {
    voteTally,

    async redeem(user, { actionId, option }) {
      const action = settings.getAction(actionId);
      if (!action) throw new HttpError(400, 'unknown_action');
      if (action.type === 'vote') {
        if (typeof option !== 'string' || !action.options.includes(option)) throw new HttpError(400, 'invalid_option');
      } else if (option !== undefined) {
        throw new HttpError(400, 'invalid_option');
      }

      const now = Date.now();
      const bananas = await db.transaction(async (trx) => {
        // Benutzer sperren: Gleichzeitige Anfragen derselben Person laufen nacheinander.
        const row = await trx('users').where({ id: user.id }).forUpdate().first('id');
        if (!row) throw new HttpError(401, 'unauthorized');

        if (action.cooldownSeconds > 0) {
          const last = await trx('redemptions')
            .where({ user_id: user.id, action_id: action.id })
            .orderBy('created_at', 'desc')
            .first('created_at');
          if (last) {
            const waitMs = Number(last.created_at) + action.cooldownSeconds * 1000 - now;
            if (waitMs > 0) throw new HttpError(429, 'cooldown', { retryAfter: Math.ceil(waitMs / 1000) });
          }
        }

        // Atomar abbuchen: nur wenn genug Guthaben da ist. So wird der Kontostand nie negativ.
        const changed = await trx('users')
          .where({ id: user.id })
          .andWhere('bananas', '>=', action.cost)
          .update({ bananas: trx.raw('?? - ?', ['bananas', action.cost]), updated_at: now });
        if (changed !== 1) throw new HttpError(402, 'not_enough_bananas');

        await trx('redemptions').insert({
          user_id: user.id,
          action_id: action.id,
          option: action.type === 'vote' ? option : null,
          cost: action.cost,
          created_at: now,
        });
        const after = await trx('users').where({ id: user.id }).first('bananas');
        return after.bananas;
      });

      const event = { type: 'redeem', actionId: action.id, actionType: action.type, actionName: action.name, displayName: user.display_name };
      if (action.type === 'vote') event.option = option;
      events.publish(event);
      if (action.type === 'vote' && settings.voteAction()?.id === action.id) {
        events.publish({ type: 'vote', ...(await voteTally()) });
      }
      return { bananas, actionId: action.id };
    },
  };
}
