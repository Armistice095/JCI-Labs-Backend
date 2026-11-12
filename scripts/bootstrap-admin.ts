// Crée le tout premier administrateur (compte Supabase + profil + rôle ADMIN global).
// Usage : npm run bootstrap:admin -- admin@jci-come.bj Fatou Zinsou [MotDePasseTemporaire]
// Sans mot de passe : un e-mail d'invitation Supabase est envoyé.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';

async function main() {
  const [email, firstName, lastName, password] = process.argv.slice(2);
  if (!email || !firstName || !lastName) throw new Error('Usage : bootstrap:admin -- <email> <prénom> <nom> [mot de passe]');
  const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Variables .env manquantes');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const normalized = email.trim().toLowerCase();

  const role = await prisma.role.findUnique({ where: { code: 'ADMIN' } });
  if (!role) throw new Error("Rôles absents : exécutez d'abord `npm run db:sql`.");
  if (await prisma.profile.findUnique({ where: { email: normalized } })) throw new Error('Ce profil existe déjà.');

  const res = password
    ? await supabase.auth.admin.createUser({ email: normalized, password, email_confirm: true })
    : await supabase.auth.admin.inviteUserByEmail(normalized);
  if (res.error || !res.data.user) throw new Error(`Supabase : ${res.error?.message}`);
  const id = res.data.user.id;

  try {
    await prisma.profile.create({ data: { id, email: normalized, firstName, lastName } });
    await prisma.userRole.create({ data: { userId: id, roleId: role.id, eventId: null } });
  } catch (e) {
    await supabase.auth.admin.deleteUser(id);
    throw e;
  }
  console.log(`Administrateur créé : ${normalized} (${id})`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
