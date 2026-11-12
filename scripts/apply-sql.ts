// Applique prisma/migrations_sql/*.sql une seule fois chacun (connexion directe), puis ré-applique le verrouillage RLS.
// Usage : npm run db:sql   (après `npm run prisma:migrate`)
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const RLS = `
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;`;

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('DIRECT_URL manquant');
  const db = new Client({ connectionString: url });
  await db.connect();
  await db.query('CREATE TABLE IF NOT EXISTS app_sql_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir = join(__dirname, '..', 'prisma', 'migrations_sql');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const done = await db.query('SELECT 1 FROM app_sql_migrations WHERE name = $1', [file]);
    if (done.rowCount) { console.log(`= ${file} (déjà appliqué)`); continue; }
    await db.query('BEGIN');
    try {
      await db.query(readFileSync(join(dir, file), 'utf8'));
      await db.query('INSERT INTO app_sql_migrations (name) VALUES ($1)', [file]);
      await db.query('COMMIT');
      console.log(`+ ${file}`);
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  }
  await db.query(RLS);
  const bad = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity");
  if (bad.rowCount) throw new Error(`Tables sans RLS : ${bad.rows.map((r) => r.tablename).join(', ')}`);
  console.log('RLS actif sur toutes les tables.');
  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
