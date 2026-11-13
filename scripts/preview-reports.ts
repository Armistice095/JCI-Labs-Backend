// Aperçu des rapports PDF avec des données d'exemple, sans base de données ni serveur.
//   npm run report:preview            → écrit rapport-*.pdf dans ./preview/
// Nécessite Chrome/Chromium (CHROMIUM_PATH si non détecté automatiquement).
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChromiumRenderer } from '../src/tickets/renderer';
import { attendanceHtml, paymentsHtml, participantsHtml, ReportMeta, ticketingHtml } from '../src/reports/report-html';

const meta: ReportMeta = { org: 'JCI Comé Excellence', editionDate: '13 novembre 2026', eventTitle: 'Leadership & Impact', eventDates: '28 novembre 2026', eventPlace: 'Centre des Congrès de Comé' };
const names = ['Adjovi Ismaël', 'Soulé Paul', 'Soulé Fabrice', 'Sossou Sènami', 'Zossou Carine', 'Dah Aïcha', 'Bello Ismaël', 'Dossou Luc', 'Agossou Edwige'];
const N = Number(process.env.PREVIEW_ROWS ?? 9);
const people = Array.from({ length: N }, (_, i) => names[i % names.length]);
const attendance = { expected: 138, expectedNote: '138 (142 billets, hors 4 remboursés)', entered: 121, absents: 17, absentsLabel: 'Absents', rate: '88 %' };

async function main() {
  const out = join(process.cwd(), 'preview'); mkdirSync(out, { recursive: true });
  const r = new ChromiumRenderer({ executablePath: process.env.CHROMIUM_PATH, headlessShell: process.env.CHROMIUM_HEADLESS_SHELL === 'true', lowMemory: process.env.CHROMIUM_LOW_MEMORY === 'true' });
  const docs: [string, string][] = [
    ['participants', participantsHtml(meta, {
      info: [['Événement', 'Leadership & Impact'], ['Statut', 'Publié, billetterie ouverte'], ['Date', '28 novembre 2026'], ['Horaires', '08h00 à 17h00'], ['Lieu', 'Centre des Congrès de Comé, Bénin'], ['Organisateur', 'JCI Comé Excellence'], ['Participants inscrits', '142'],
        ['Programme', '08h00 Accueil · 09h00 Ouverture officielle · 10h30 Conférence · 12h30 Pause déjeuner · 14h00 Ateliers · 16h30 Clôture']],
      rows: people.map((n, i) => ({ name: n, phone: `+229 01 95 78 95 ${String(10 + (i % 80))}`, email: `${n.split(' ')[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}.${i}@exemple.bj` })), excluded: 4,
    })],
    ['billetterie', ticketingHtml(meta, {
      capacity: 200, sold: 142, soldNote: '142 (dont 4 remboursés)', remaining: 62, fillRate: '69 %', gross: 594000, refunded: 12000, refundedTickets: 4, net: 582000,
      categories: [{ name: 'Standard', price: 3000, sold: 118, refunded: 4, net: 342000 }, { name: 'VIP', price: 10000, sold: 24, refunded: 0, net: 240000 }], cancelledNote: null,
      sales: [{ label: '5–11 oct.', value: 18 }, { label: '12–18 oct.', value: 31 }, { label: '19–25 oct.', value: 42 }, { label: '26 oct.–1 nov.', value: 29 }, { label: '2–8 nov.', value: 22 }],
      salesCaption: 'Billets vendus par semaine depuis l’ouverture de la billetterie.',
      modes: [{ label: 'Espèces', net: 186000, share: 0.32 }, { label: 'Mobile Money direct', net: 168000, share: 0.29 }, { label: 'FedaPay, carte', net: 132000, share: 0.23 }, { label: 'FedaPay, Mobile Money', net: 96000, share: 0.16 }],
      attendance, anomalies: [{ label: 'Billet déjà scanné', count: 5, detail: 'Tentative d’entrée avec un billet déjà validé' }, { label: 'Billet non reconnu', count: 3, detail: 'Code introuvable dans la base' }, { label: 'Billet remboursé', count: 1, detail: 'Billet présenté après remboursement' }],
    })],
    ['presences', attendanceHtml(meta, {
      ...attendance, anomaliesCount: 9, firstScan: '08h06', lastScan: '11h52',
      byCategory: [{ name: 'Standard', expected: 114, entered: 101, absents: 13, rate: '89 %' }, { name: 'VIP', expected: 24, entered: 20, absents: 4, rate: '83 %' }],
      hourly: [{ label: '08h–09h', value: 54 }, { label: '09h–10h', value: 41 }, { label: '10h–11h', value: 17 }, { label: '11h–12h', value: 6 }, { label: 'Après 12h', value: 3 }],
      scans: people.map((n, i) => ({ time: `08h${String(6 + i).padStart(2, '0')}`, name: n, category: i % 5 ? 'Standard' : 'VIP', number: `JCI-2026-${String(i + 1).padStart(6, '0')}` })),
      anomalies: [{ time: '08h24', reference: 'JCI-2026-000004', label: 'Billet remboursé' }, { time: '08h58', reference: 'JCI-2026-000002', label: 'Billet déjà scanné' }, { time: '09h07', reference: 'Code abc123…', label: 'Billet non reconnu' }],
    })],
    ['paiements', paymentsHtml(meta, {
      orders: 54, approved: 45, approvedRefunded: 4, failed: 7, pending: 2, toRefund: 0, toRefundAmount: 0, successRate: '83 %', collected: 240000, refunded: 12000, net: 228000,
      methods: [{ label: 'Carte bancaire', orders: 24, approved: 18, refunded: 2, failed: 5, net: 132000 }, { label: 'Mobile Money', orders: 30, approved: 27, refunded: 2, failed: 2, net: 96000 }, { label: 'Espèces', orders: 62, approved: 62, refunded: 0, failed: 0, net: 186000 }],
      weekly: [{ label: '5–11 oct.', value: 6 }, { label: '12–18 oct.', value: 11 }, { label: '19–25 oct.', value: 13 }, { label: '26 oct.–1 nov.', value: 9 }, { label: '2–8 nov.', value: 6 }],
      weeklyCaption: 'Transactions approuvées par semaine depuis l’ouverture de la billetterie.',
      transactions: people.map((n, i) => ({ date: `${5 + i} oct. 2026`, order: `CMD-2026-${String(i + 1).padStart(4, '0')}`, buyer: n, method: i % 2 ? 'Carte' : 'Mobile Money', amount: i % 3 ? 3000 : 10000,
        ...([['Approuvée', 'ok'], ['Échouée', 'ko'], ['Remboursée', 'refund'], ['En attente', 'wait']] as const).map(([status, tone]) => ({ status, tone }))[i % 4] })),
      refunds: [{ date: '9 oct. 2026', order: 'CMD-2026-0005', buyer: 'Sossou Sènami', amount: 3000 }, { date: '14 oct. 2026', order: 'CMD-2026-0021', buyer: 'Ahouansou Brice', amount: 3000 }],
      toRefundRows: [],
    })],
  ];
  try {
    for (const [name, html] of docs) {
      const t0 = Date.now(); const pdf = await r.renderPdf(html);
      writeFileSync(join(out, `rapport-${name}.pdf`), pdf);
      console.log(`✔ ${name} : ${(pdf.length / 1024).toFixed(0)} Ko en ${Date.now() - t0} ms`);
    }
  } finally { await r.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
