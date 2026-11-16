// Datenbank: Knex-Verbindung (SQLite lokal, MySQL online) und Migrationen.
// Alle Abfragen laufen mit Parametern, nie mit zusammengebauten SQL-Strings.
import fs from 'node:fs';
import path from 'node:path';
import knex from 'knex';

export function createDb(config) {
  const d = config.database;
  if (d.kind === 'sqlite') {
    fs.mkdirSync(path.dirname(d.filename), { recursive: true });
    return knex({
      client: 'better-sqlite3',
      connection: { filename: d.filename },
      useNullAsDefault: true,
      // Eine einzige Verbindung: Transaktionen laufen bei SQLite damit sicher nacheinander.
      pool: {
        min: 1,
        max: 1,
        afterCreate(conn, done) {
          try {
            conn.pragma('foreign_keys = ON');
            done(null, conn);
          } catch (err) {
            done(err, conn);
          }
        },
      },
    });
  }
  return knex({
    client: 'mysql2',
    connection: {
      host: d.host,
      port: d.port,
      user: d.user,
      password: d.password,
      database: d.database,
      charset: 'utf8mb4',
    },
    pool: { min: 0, max: 10 },
  });
}

const migrations = [
  {
    name: '001_grundtabellen',
    async up(db) {
      const isMysql = db.client.config.client === 'mysql2';
      // utf8mb4, damit Emojis in Namen und Währung bei MySQL nicht kaputtgehen
      const utf8 = (t) => {
        if (isMysql) {
          t.charset('utf8mb4');
          t.collate('utf8mb4_unicode_ci');
        }
      };

      await db.schema.createTable('users', (t) => {
        utf8(t);
        t.increments('id');
        t.string('twitch_id', 32).notNullable().unique();
        t.string('login', 64).notNullable();
        t.string('display_name', 100).notNullable();
        t.integer('bananas').notNullable().defaultTo(0);
        t.integer('watch_minutes').notNullable().defaultTo(0);
        t.boolean('follow_bonus_granted').notNullable().defaultTo(false);
        t.string('last_checkin_date', 10).nullable();
        t.bigInteger('created_at').notNullable();
        t.bigInteger('updated_at').notNullable();
        t.index(['bananas']);
        // Zweite Sicherung: Der Kontostand kann in der Datenbank nie negativ werden.
        t.check('?? >= 0', ['bananas'], 'users_kontostand_nicht_negativ');
      });

      await db.schema.createTable('sessions', (t) => {
        utf8(t);
        t.string('id_hash', 64).primary();
        t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
        t.bigInteger('created_at').notNullable();
        t.bigInteger('expires_at').notNullable();
        t.index(['expires_at']);
      });

      await db.schema.createTable('follows', (t) => {
        utf8(t);
        t.string('twitch_id', 32).primary();
        t.boolean('bonus_granted').notNullable().defaultTo(false);
        t.bigInteger('created_at').notNullable();
      });

      await db.schema.createTable('eventsub_messages', (t) => {
        utf8(t);
        t.string('message_id', 128).primary();
        t.bigInteger('received_at').notNullable();
        t.index(['received_at']);
      });

      await db.schema.createTable('redemptions', (t) => {
        utf8(t);
        t.increments('id');
        t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
        t.string('action_id', 50).notNullable();
        t.string('option', 100).nullable();
        t.integer('cost').notNullable();
        t.bigInteger('created_at').notNullable();
        t.index(['user_id', 'action_id', 'created_at']);
        t.index(['action_id', 'created_at']);
      });

      await db.schema.createTable('app_state', (t) => {
        utf8(t);
        t.string('key', 64).primary();
        t.text('value');
      });

      await db.schema.createTable('settings', (t) => {
        utf8(t);
        t.string('key', 16).primary();
        t.text('value').notNullable();
        t.bigInteger('updated_at').notNullable();
      });

      await db.schema.createTable('streamer_auth', (t) => {
        utf8(t);
        t.integer('id').primary();
        t.text('refresh_token_enc').notNullable();
        t.text('scopes').notNullable();
        t.bigInteger('updated_at').notNullable();
      });
    },
    async down(db) {
      for (const name of ['streamer_auth', 'settings', 'app_state', 'redemptions', 'eventsub_messages', 'follows', 'sessions', 'users']) {
        await db.schema.dropTableIfExists(name);
      }
    },
  },
];

const migrationSource = {
  getMigrations: async () => migrations,
  getMigrationName: (m) => m.name,
  getMigration: async (m) => m,
};

export async function migrate(db) {
  await db.migrate.latest({ migrationSource });
}

/** Kleiner Schlüssel-Wert-Speicher (Tabelle app_state). Hier liegen nie Tokens. */
export function createState(db) {
  return {
    async get(key, trx = db) {
      const row = await trx('app_state').where({ key }).first();
      return row ? row.value : null;
    },
    async set(key, value, trx = db) {
      await trx('app_state').insert({ key, value: String(value) }).onConflict('key').merge();
    },
  };
}
