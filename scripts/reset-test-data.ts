// Nettoie les données de TEST avant la mise en production.
//
//   À blanc (ne modifie rien, affiche ce qui serait supprimé) :
//     npm run db:reset -- --scope=sales
//     npm run db:reset -- --scope=all
//   Pour de vrai :
//     npm run db:reset -- --scope=sales --apply --confirm-host=<hôte affiché par l'exécution à blanc>
//
//   --scope=sales  supprime les ventes de test : commandes, billets, paiements, scans, e-mails, journal d'audit, fichiers de billets,
//                  statistiques de vues ; remet à zéro les compteurs (prochain billet : …-000001, prochaine commande : CMD-0001)
//                  et les stocks des catégories. Les ÉVÉNEMENTS, leurs catégories et leurs affiches sont conservés.
//   --scope=all    fait la même chose ET supprime tous les événements (catégories, affiches, programme, organisateurs).
//   --remove-members=a@x.bj,b@y.bj   supprime aussi ces comptes de test (profil + compte Supabase). Refusé s'il ne resterait aucun administrateur actif.
//   --skip-storage                   ne touche pas à Supabase Storage (tests locaux).
//   --allow-repeat                   permet de relancer après un premier nettoyage réel (sinon refusé : protège les vraies ventes).
//
// Ne touche JAMAIS : rôles, permissions, administrateurs conservés, paramètres, migrations, files de tâches (structure).
import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Client } from 'pg';

const arg = (name: string) => process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const val = (name: string) => arg(name)?.split('=').slice(1).join('=');
const flag = (name: string) => !!arg(name);

const SALES_TABLES = ['checkin_attempts', 'generated_files', 'email_logs', 'payment_events', 'payments', 'tickets', 'order_holders', 'order_items', 'orders', 'export_jobs', 'audit_logs', 'event_view_daily'];
const EVENT_TABLES = ['events', 'ticket_categories', 'event_posters', 'event_organizers', 'event_programme_items'];

const fail = (msg: string): never => { console.error(`\n✖ ${msg}\n`); process.exit(1); };

async function emptyBucket(supabase: SupabaseClient<any, any, any>, bucket: string, only?: string[]): Promise<number> {
  const files: string[] = [];
  const walk = async (prefix: string) => {
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 100, offset });
      if (error) throw new Error(`Stockage ${bucket} : ${error.message}`);
      if (!data?.length) break;
      for (const o of data) (o.id ? files.push(prefix ? `${prefix}/${o.name}` : o.name) : await walk(prefix ? `${prefix}/${o.name}` : o.name));
      if (data.length < 100) break;
    }
  };
  if (only) files.push(...only); else await walk('');
  for (let i = 0; i < files.length; i += 100) {
    const { error } = await supabase.storage.from(bucket).remove(files.slice(i, i + 100));
    if (error) throw new Error(`Stockage ${bucket} : ${error.message}`);
  }
  return files.length;
}

async function main() {
  const scope = val('scope');
  if (scope !== 'sales' && scope !== 'all') return fail('Précisez --scope=sales (garde les événements) ou --scope=all (supprime aussi les événements). Voir l\'en-tête du script.');
  const apply = flag('apply');
  const url = process.env.DIRECT_URL;
  if (!url) return fail('DIRECT_URL manquant dans .env');
  const host = new URL(url).hostname;
  const removeMembers = (val('remove-members') ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const skipStorage = flag('skip-storage');
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!skipStorage || removeMembers.length) if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return fail('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants dans .env (ou utilisez --skip-storage).');
  const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
  const ticketsBucket = process.env.TICKETS_BUCKET ?? 'tickets';
  const posterBucket = process.env.POSTER_BUCKET ?? 'event-posters';

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const count = async (t: string) => Number((await db.query(`SELECT count(*) FROM ${t}`)).rows[0].count);
    console.log(`\nBase de données : ${host}`);
    console.log(`Mode : ${apply ? 'APPLICATION RÉELLE' : 'à blanc (rien n\'est modifié)'} · portée : ${scope}\n`);
    console.log('Sera supprimé :');
    const tables = scope === 'all' ? [...SALES_TABLES, ...EVENT_TABLES] : SALES_TABLES;
    for (const t of tables) console.log(`  ${t.padEnd(24)} ${String(await count(t)).padStart(6)} ligne(s)`);
    const paid = Number((await db.query(`SELECT count(*) FROM orders WHERE status = 'PAID'`)).rows[0].count);
    const poster = (await db.query(`SELECT storage_path FROM event_posters`)).rows.map((r) => r.storage_path as string);
    console.log(`\n  commandes payées parmi elles : ${paid}`);
    console.log(`  fichiers de billets (bucket « ${ticketsBucket} ») : tous${scope === 'all' ? `\n  affiches (bucket « ${posterBucket} ») : ${poster.length} fichier(s)` : ''}`);
    console.log('  compteurs de numérotation : remis à zéro · stocks des catégories : remis à zéro');
    const roles = (await db.query(`SELECT count(*) FROM user_roles WHERE event_id IS NULL`)).rows[0].count;
    console.log(`\nConservé : rôles, permissions, paramètres, ${roles} attribution(s) de rôle globale(s), comptes (sauf ceux de --remove-members)`);

    const profiles = (await db.query(`SELECT p.id, p.email, p.first_name, p.last_name, p.status,
        COALESCE(array_agg(r.code) FILTER (WHERE r.code IS NOT NULL AND ur.event_id IS NULL), '{}') AS roles
      FROM profiles p LEFT JOIN user_roles ur ON ur.user_id = p.id LEFT JOIN roles r ON r.id = ur.role_id GROUP BY p.id ORDER BY p.email`)).rows;
    console.log('\nComptes existants :');
    for (const p of profiles) console.log(`  ${removeMembers.includes(p.email) ? '✖ supprimé →' : '  conservé  '} ${p.email.padEnd(34)} ${p.status.padEnd(10)} ${(p.roles as string[]).join(', ') || '—'}`);
    const unknown = removeMembers.filter((e) => !profiles.some((p) => p.email === e));
    if (unknown.length) return fail(`Compte(s) introuvable(s) : ${unknown.join(', ')}`);
    const remainingAdmins = profiles.filter((p) => !removeMembers.includes(p.email) && p.status === 'ACTIVE' && (p.roles as string[]).includes('ADMIN'));
    if (removeMembers.length && !remainingAdmins.length) return fail('Aucun administrateur actif ne resterait : suppression refusée.');

    const locked = (await db.query(`SELECT value FROM app_settings WHERE key = 'production_reset_at'`)).rows[0];
    if (!apply) {
      console.log(`\nRien n'a été modifié. Pour appliquer (⚠ faites d'abord une sauvegarde) :\n  npm run db:reset -- --scope=${scope}${removeMembers.length ? ` --remove-members=${removeMembers.join(',')}` : ''} --apply --confirm-host=${host}\n`);
      if (locked) console.log(`Note : un nettoyage réel a déjà eu lieu (${JSON.stringify(locked.value)}). Il faudra ajouter --allow-repeat.\n`);
      return;
    }
    if (val('confirm-host') !== host) return fail(`Confirmation absente ou incorrecte : ajoutez --confirm-host=${host}`);
    if (locked && !flag('allow-repeat')) return fail(`Un nettoyage réel a déjà été fait (${JSON.stringify(locked.value)}). Relancer détruirait de VRAIES ventes. Si c'est voulu : --allow-repeat.`);

    // 1) base de données : tout ou rien
    await db.query('BEGIN');
    try {
      await db.query(`TRUNCATE ${SALES_TABLES.join(', ')}`);
      await db.query('DELETE FROM counters');
      await db.query('UPDATE ticket_categories SET sold_count = 0, reserved_count = 0');
      if (scope === 'all') {
        await db.query('DELETE FROM user_roles WHERE event_id IS NOT NULL');
        await db.query('DELETE FROM events'); // supprime en cascade catégories, affiches, programme, organisateurs
      }
      const hasJobs = (await db.query(`SELECT to_regclass('pgboss.job') AS j, to_regclass('pgboss.archive') AS a`)).rows[0];
      if (hasJobs.j) await db.query('TRUNCATE pgboss.job');
      if (hasJobs.a) await db.query('TRUNCATE pgboss.archive');
      await db.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('production_reset_at', $1::jsonb, now())
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ at: new Date().toISOString(), scope })]);
      await db.query('COMMIT');
      console.log('\n✔ Base de données nettoyée.');
    } catch (e) { await db.query('ROLLBACK'); throw e; }

    // 2) stockage
    if (!skipStorage && supabase) {
      console.log(`✔ ${await emptyBucket(supabase, ticketsBucket)} fichier(s) de billets supprimé(s).`);
      if (scope === 'all') console.log(`✔ ${await emptyBucket(supabase, posterBucket, poster)} affiche(s) supprimée(s).`);
    }

    // 3) comptes de test
    for (const email of removeMembers) {
      const p = profiles.find((x) => x.email === email)!;
      try {
        await db.query('DELETE FROM profiles WHERE id = $1', [p.id]); // les rôles partent en cascade
        const { error } = await supabase!.auth.admin.deleteUser(p.id);
        if (error) throw new Error(error.message);
        console.log(`✔ Compte supprimé : ${email}`);
      } catch (e) {
        console.error(`✖ ${email} : ${(e as Error).message}\n  (probablement encore référencé par un événement conservé : désactivez-le plutôt dans la plateforme, ou utilisez --scope=all)`);
      }
    }
    console.log('\nTerminé. Prochain billet : …-000001 · prochaine commande : CMD-0001.\n');
  } finally { await db.end(); }
}
main().catch((e) => { console.error(`\n✖ ${e.message ?? e}\n`); process.exit(1); });
