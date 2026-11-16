// Einstellungen des Hubs. Beim ersten Start kommen sie aus hub.config.json,
// danach gelten nur noch die Werte aus der Datenbank (änderbar auf der Admin-Seite).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CURRENCY_DIR, SetupProblem, readStartSettings } from '../config.js';

export const CURRENCY_IMAGE_PATTERN = /^[A-Za-z0-9_-]{1,60}\.(png|jpg|jpeg|webp|gif)$/;

const text = (min, max) => z.string().trim().min(min).max(max);
const int = (min, max) => z.int().min(min).max(max);

const actionBase = {
  id: z.string().regex(/^[a-z0-9-]{2,30}$/),
  name: text(1, 40),
  description: text(0, 120),
  cost: int(1, 100000),
  cooldownSeconds: int(0, 86400),
};

const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...actionBase, type: z.literal('sound') }),
  z.strictObject({ ...actionBase, type: z.literal('rain') }),
  z.strictObject({
    ...actionBase,
    type: z.literal('vote'),
    options: z
      .array(text(1, 40))
      .min(2)
      .max(6)
      .superRefine((options, ctx) => {
        const seen = new Set();
        options.forEach((option, i) => {
          if (seen.has(option)) ctx.addIssue({ code: 'custom', message: 'Diese Option gibt es schon.', path: [i] });
          seen.add(option);
        });
      }),
  }),
]);

/** Dasselbe strikte Schema für die Startwerte und für jede Änderung über die Admin-Seite. */
export const settingsSchema = z.strictObject({
  hubName: text(1, 40),
  currencyName: text(1, 20),
  currencyEmoji: text(1, 8),
  currencyImage: z.union([z.null(), z.string().regex(CURRENCY_IMAGE_PATTERN)]),
  checkinBananas: int(0, 10000),
  followBonus: int(0, 100000),
  watchBananas: int(0, 10000),
  watchIntervalMinutes: int(1, 120),
  leaderboardSize: int(3, 50),
  actions: z
    .array(actionSchema)
    .min(1)
    .max(20)
    .superRefine((actions, ctx) => {
      const seen = new Set();
      actions.forEach((action, i) => {
        if (seen.has(action.id)) ctx.addIssue({ code: 'custom', message: 'Diese Kennung gibt es schon.', path: [i, 'id'] });
        seen.add(action.id);
      });
    }),
});

/** Macht aus zod-Fehlern verständliche Meldungen ohne Interna. */
function friendlyMessage(issue) {
  switch (issue.code) {
    case 'custom':
      return issue.message;
    case 'invalid_type':
      if (issue.expected === 'int' || issue.expected === 'number') return 'Bitte eine ganze Zahl eingeben.';
      if (issue.expected === 'string') return 'Bitte einen Text eingeben.';
      if (issue.expected === 'array') return 'Hier wird eine Liste erwartet.';
      return 'Dieser Wert fehlt oder hat die falsche Form.';
    case 'too_small':
      if (issue.origin === 'string') return issue.minimum === 1 ? 'Bitte ausfüllen.' : `Mindestens ${issue.minimum} Zeichen.`;
      if (issue.origin === 'array') return `Mindestens ${issue.minimum} Einträge.`;
      return `Der Wert muss mindestens ${issue.minimum} sein.`;
    case 'too_big':
      if (issue.origin === 'string') return `Höchstens ${issue.maximum} Zeichen.`;
      if (issue.origin === 'array') return `Höchstens ${issue.maximum} Einträge.`;
      return `Der Wert darf höchstens ${issue.maximum} sein.`;
    case 'unrecognized_keys':
      return 'Hier steht ein unbekanntes Feld.';
    case 'invalid_format':
      return 'Dieser Wert hat nicht das erlaubte Format.';
    default:
      return 'Dieser Wert ist nicht erlaubt.';
  }
}

export const toIssues = (zodError) =>
  zodError.issues.slice(0, 50).map((issue) => ({ path: issue.path.map(String).join('.'), message: friendlyMessage(issue) }));

async function currencyImageExists(name) {
  if (name === null) return true;
  if (!CURRENCY_IMAGE_PATTERN.test(name)) return false;
  try {
    const stat = await fs.promises.stat(path.join(CURRENCY_DIR, name));
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Alle Bilder im Ordner public/waehrung/, die als Währungsbild erlaubt sind. */
export async function listCurrencyImages() {
  try {
    const entries = await fs.promises.readdir(CURRENCY_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && CURRENCY_IMAGE_PATTERN.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Prüft Einstellungen komplett. Ergebnis: { ok: true, settings } oder { ok: false, issues }. */
export async function validateSettings(input) {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: toIssues(parsed.error) };
  if (!(await currencyImageExists(parsed.data.currencyImage))) {
    return { ok: false, issues: [{ path: 'currencyImage', message: 'Dieses Bild gibt es im Ordner public/waehrung/ nicht.' }] };
  }
  return { ok: true, settings: parsed.data };
}

const firstVote = (settings) => settings.actions.find((a) => a.type === 'vote') || null;

export function createSettings({ db, config, state }) {
  let current = null;

  async function store(settings, trx = db) {
    const row = { key: 'hub', value: JSON.stringify(settings), updated_at: Date.now() };
    await trx('settings').insert(row).onConflict('key').merge();
  }

  return {
    /** Beim Start: Einstellungen aus der Datenbank laden oder Startwerte übernehmen. */
    async init() {
      const row = await db('settings').where({ key: 'hub' }).first();
      if (row) {
        let parsed;
        try {
          parsed = settingsSchema.safeParse(JSON.parse(row.value));
        } catch {
          parsed = { success: false };
        }
        if (!parsed.success) throw new SetupProblem('Einstellungen in der Datenbank', 'ungültig');
        current = parsed.data;
        return;
      }
      const result = await validateSettings(readStartSettings(config));
      if (!result.ok) throw new SetupProblem('hub.config.json', 'ungültig');
      await store(result.settings);
      current = result.settings;
    },

    get: () => current,

    getAction: (id) => current.actions.find((a) => a.id === id) || null,

    /** Die erste Aktion vom Typ „vote“ ist die laufende Abstimmung. */
    voteAction: () => firstVote(current),

    /** Speichert geprüfte Einstellungen. Geänderte Abstimmungs-Optionen setzen die Abstimmung zurück. */
    async save(next) {
      const before = firstVote(current);
      const after = firstVote(next);
      const voteChanged = JSON.stringify(before ? [before.id, before.options] : null) !== JSON.stringify(after ? [after.id, after.options] : null);
      await db.transaction(async (trx) => {
        await store(next, trx);
        if (voteChanged) await state.set('vote_reset_at', Date.now(), trx);
      });
      current = next;
      return current;
    },

    /** Was jeder Besucher sehen darf (ohne Ranglistengröße). */
    publicConfig() {
      const s = current;
      return {
        hubName: s.hubName,
        currencyName: s.currencyName,
        currencyEmoji: s.currencyEmoji,
        currencyImage: s.currencyImage,
        checkinBananas: s.checkinBananas,
        followBonus: s.followBonus,
        watchBananas: s.watchBananas,
        watchIntervalMinutes: s.watchIntervalMinutes,
        actions: s.actions,
      };
    },
  };
}
