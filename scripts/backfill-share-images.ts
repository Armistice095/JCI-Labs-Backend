// Crée la variante d'aperçu (1200×630, JPEG léger) des affiches déjà envoyées avant la version 0.13.2.
//   npm run posters:share            → traite les affiches qui n'ont pas encore de variante (sans risque : relançable)
//   npm run posters:share -- --force → recrée toutes les variantes
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '@prisma/client';
import { buildShareImage } from '../src/events/share-image';

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants dans .env');
  const bucketName = process.env.POSTER_BUCKET ?? 'event-posters';
  const bucket = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage.from(bucketName);
  const prisma = new PrismaClient();
  try {
    const posters = await prisma.eventPoster.findMany({ where: process.argv.includes('--force') ? {} : { sharePath: null } });
    console.log(`${posters.length} affiche(s) à traiter.`);
    let ok = 0;
    for (const p of posters) {
      try {
        const { data, error } = await bucket.download(p.storagePath);
        if (error || !data) throw new Error(error?.message ?? 'téléchargement impossible');
        const jpeg = await buildShareImage(Buffer.from(await data.arrayBuffer()), p.mime as 'image/png' | 'image/jpeg');
        const path = p.storagePath.replace(/\.[a-z]+$/, '-share.jpg');
        const up = await bucket.upload(path, jpeg, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: true });
        if (up.error) throw new Error(up.error.message);
        await prisma.eventPoster.update({ where: { id: p.id }, data: { sharePath: path } });
        ok++; console.log(`✔ ${p.storagePath} → ${path} (${Math.round(jpeg.length / 1024)} Ko)`);
      } catch (e) { console.error(`✖ ${p.storagePath} : ${(e as Error).message}`); }
    }
    console.log(`Terminé : ${ok}/${posters.length}.`);
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
