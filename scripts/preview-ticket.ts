// Aperçu du design des billets, sans base de données ni serveur.
//   npm run ticket:preview                       → écrit des exemples dans ./preview/
//   npm run ticket:preview -- --poster affiche.jpg --accent "#E9B63B" --title "Passation de charge"
// Aucun navigateur nécessaire : PNG et PDF sortent du même dessin SVG.
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TicketRenderData } from '../src/tickets/design/types';
import { TicketRenderer } from '../src/tickets/ticket-renderer';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };

async function main() {
  const out = join(process.cwd(), 'preview'); mkdirSync(out, { recursive: true });
  const posterFile = arg('poster');
  const poster = posterFile ? `data:${/\.png$/i.test(posterFile) ? 'image/png' : 'image/jpeg'};base64,${readFileSync(posterFile).toString('base64')}` : null;
  const base: TicketRenderData = {
    number: 'JCI-2026-000001', qrUrl: 'https://jcicomee.com/billet/Xk3pQ9wLm2RtY7vNb4HsDa',
    holderFirstName: arg('first') ?? 'Koffi', holderLastName: arg('last') ?? 'Ahoussou',
    categoryName: arg('category') ?? 'Pass simple', priceXof: Number(arg('price') ?? 5000), conditions: arg('conditions') ?? null,
    event: {
      title: arg('title') ?? 'Passation de charge', category: arg('type') ?? 'GALA', startsAt: new Date(arg('date') ?? '2026-12-19T18:19:00Z'),
      venueName: arg('venue') ?? 'Centre des Congrès de Comé', city: arg('city') ?? 'Comé', accentColor: arg('accent') ?? null, publicUrl: 'https://jcicomee.com/evenements/passation-de-charge-2026',
    },
    posterDataUri: poster,
  };
  const r = new TicketRenderer();
  r.onModuleInit();
  for (const [name, data] of [['avec-affiche', base], ['sans-affiche', { ...base, posterDataUri: null }]] as const) {
    if (name === 'avec-affiche' && !poster) continue;
    const t0 = performance.now();
    const t = await r.render(data);
    writeFileSync(join(out, `billet-${name}.png`), t.png); writeFileSync(join(out, `billet-${name}.pdf`), t.pdf);
    console.log(`✔ ${name} : ${Math.round(performance.now() - t0)} ms · PNG ${(t.png.length / 1024).toFixed(0)} Ko · PDF ${(t.pdf.length / 1024).toFixed(0)} Ko`);
  }
  console.log(`Écrit dans ${out}`);
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
