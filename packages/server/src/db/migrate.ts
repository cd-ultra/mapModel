/**
 * Minimal forward-only migration runner.
 *
 * Applies every .sql file in ../migrations in filename order, recording what
 * has run in a `schema_migrations` table. Deliberately small: adding a
 * migration framework is a decision for whoever operates this, and a
 * transactional runner covers the schema as it stands.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/**
 * Arbitrary constant naming this app's migration lock in Postgres's shared
 * advisory-lock namespace (a plain int8, no side effect beyond serializing
 * callers). Needed because a serverless deployment can cold-start several
 * instances at once, each racing to run the same unapplied migration —
 * without it, two instances can both pass the "not yet applied" check and
 * then collide inserting the same `schema_migrations` row.
 */
const MIGRATION_LOCK_ID = 727_363_912;

export async function runMigrations(pool: Pool): Promise<string[]> {
  // Everything below runs on one held connection, not `pool.query`/
  // `pool.connect()` per call: an advisory lock is session-scoped, and a
  // pool configured with max:1 (see bootstrap.ts) would otherwise deadlock
  // waiting for a second connection while this one holds the lock.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      try {
        // One transaction per migration: a failure leaves the schema untouched
        // and the migration unrecorded, so a fixed version can simply re-run.
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        ran.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {
      // The connection may already be broken (e.g. the migration threw
      // because the connection died); nothing to unlock in that case.
    });
    client.release();
  }
}

// Executed directly via `npm run migrate`.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL is required to run migrations');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  runMigrations(pool)
    .then((ran) => {
      console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Already up to date');
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
