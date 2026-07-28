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

export async function runMigrations(pool: Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
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
    } finally {
      client.release();
    }
  }
  return ran;
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
