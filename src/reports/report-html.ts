import { loadAssets } from '../tickets/design/assets';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bar, cssString, esc, int, pct, xof } from './report-format';

/* ──────────────────────────── Données des rapports (calculées par le service, mises en page ici) ──────────────────────────── */

export interface ReportMeta {
  org: string;               // JCI Comé Excellence
  editionDate: string;       // 13 novembre 2026
  eventTitle: string;
  eventDates: string;        // 14 novembre 2026
  eventPlace: string;        // GI Mono, Comé
}

export type EventInfoRow = [label: string, value: string];

export interface ParticipantsReport {
  info: EventInfoRow[];
  rows: { name: string; phone: string; email: string }[];
  excluded: number;          // billets annulés ou remboursés, non listés
}

export interface AttendanceBlock {
  expected: number; expectedNote: string; entered: number; absents: number; absentsLabel: string; rate: string;
}
export interface AnomalyRow { label: string; count: number; detail: string }

export interface TicketingReport {
  capacity: number; sold: number; soldNote: string; remaining: number; fillRate: string;
  gross: number; refunded: number; refundedTickets: number; net: number;
  categories: { name: string; price: number; sold: number; refunded: number; net: number }[];
  cancelledNote: string | null;
  sales: Bar[]; salesCaption: string;
  modes: { label: string; net: number; share: number }[];
  attendance: AttendanceBlock;
  anomalies: AnomalyRow[];
}

export interface AttendanceReport extends AttendanceBlock {
  anomaliesCount: number; firstScan: string; lastScan: string;
  byCategory: { name: string; expected: number; entered: number; absents: number; rate: string }[];
  hourly: Bar[];
  scans: { time: string; name: string; category: string; number: string }[];
  anomalies: { time: string; reference: string; label: string }[];
}

export type PaymentTone = 'ok' | 'ko' | 'refund' | 'wait';
export interface PaymentsReport {
  orders: number; approved: number; approvedRefunded: number; failed: number; pending: number; toRefund: number; toRefundAmount: number;
  successRate: string; collected: number; refunded: number; net: number;
  methods: { label: string; orders: number; approved: number; refunded: number; failed: number; net: number }[];
  weekly: Bar[]; weeklyCaption: string;
  transactions: { date: string; order: string; buyer: string; method: string; amount: number; status: string; tone: PaymentTone }[];
  refunds: { date: string; order: string; buyer: string; amount: number }[];
  toRefundRows: { date: string; order: string; buyer: string; amount: number; reason: string }[];
}

/* ──────────────────────────── Charte graphique (modèles validés : Poppins, bleu nuit et bleu JCI) ──────────────────────────── */

const C = { navy: '#0f0b33', ink: '#15103f', blue: '#0ea5e9', h2: '#0284c7', cyan: '#5bc8d8', band: '#f3f6fc', total: '#eaf6fd', track: '#dce3f0', grey: '#7e8490', green: '#15803d', red: '#b91c1c', info: '#0369a1', orange: '#b45309' };

const FONT_FILES: [number, string][] = [[400, 'poppins-latin-400-normal.woff2'], [500, 'poppins-latin-500-normal.woff2'], [600, 'poppins-latin-600-normal.woff2'], [700, 'poppins-latin-700-normal.woff2']];
let poppinsCss: string | null = null;
function fontCss(): string {
  if (poppinsCss) return poppinsCss;
  const dir = [join(__dirname, '..', '..', 'assets', 'fonts'), join(__dirname, '..', '..', '..', 'assets', 'fonts'), join(process.cwd(), 'assets', 'fonts')]
    .find((d) => { try { readFileSync(join(d, FONT_FILES[0][1])); return true; } catch { return false; } });
  if (!dir) throw new Error('Polices Poppins introuvables (dossier assets/fonts).');
  poppinsCss = FONT_FILES.map(([w, f]) => `@font-face{font-family:'Poppins';font-weight:${w};font-style:normal;src:url(data:font/woff2;base64,${readFileSync(join(dir, f)).toString('base64')}) format('woff2');}`).join('\n');
  return poppinsCss;
}

/* ──────────────────────────── Briques de mise en page ──────────────────────────── */

const empty = (cols: number, text: string) => `<tr class="empty"><td colspan="${cols}">${esc(text)}</td></tr>`;

function chapter(n: number, title: string, intro: string, newPage = false): string {
  return `<header class="chapter${newPage ? ' newpage' : ''}"><div class="ch-label">CHAPITRE ${String(n).padStart(2, '0')}</div><h1>${esc(title)}</h1><p class="intro">${esc(intro)}</p></header>`;
}

const h2 = (t: string) => `<h2>${esc(t)}</h2>`;

/** Tableau « libellé / valeur » (chiffres clés, informations générales). Les valeurs sont du texte brut. */
function kv(rows: [string, string][], opts: { strongLast?: boolean; plain?: boolean } = {}): string {
  return `<table class="kv${opts.plain ? ' plain' : ''}"><tbody>${rows.map(([k, v], i) => `<tr${opts.strongLast && i === rows.length - 1 ? ' class="hl"' : ''}><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
}

interface Col { label: string; align?: 'right'; width?: string }
/** Tableau de données. `rows` : cellules en HTML déjà neutralisé (voir `esc`). Ligne de titres répétée à chaque page, lignes jamais coupées. */
function table(cols: Col[], rows: string[][], opts: { total?: string[]; emptyText?: string; cls?: string } = {}): string {
  const head = cols.map((c) => `<th${c.align ? ` class="r"` : ''}${c.width ? ` style="width:${c.width}"` : ''}>${esc(c.label)}</th>`).join('');
  const body = rows.length
    ? rows.map((r) => `<tr>${r.map((c, i) => `<td${cols[i].align ? ' class="r"' : ''}>${c}</td>`).join('')}</tr>`).join('')
    : empty(cols.length, opts.emptyText ?? 'Aucune donnée pour le moment.');
  const total = opts.total ? `<tr class="tot">${opts.total.map((c, i) => `<td${cols[i].align ? ' class="r"' : ''}>${c}</td>`).join('')}</tr>` : '';
  return `<table class="data ${opts.cls ?? ''}"><thead><tr>${head}</tr></thead><tbody>${body}${total}</tbody></table>`;
}

function bars(data: Bar[], caption: string, emptyText: string): string {
  if (!data.length || data.every((b) => b.value === 0)) return `<div class="chart-empty">${esc(emptyText)}</div>`;
  const max = Math.max(...data.map((b) => b.value));
  const cols = data.map((b) => `<div class="bar-col"><div class="bar-val">${int(b.value)}</div><div class="bar" style="height:${Math.max(1, Math.round((b.value / max) * 100))}%"></div></div>`).join('');
  const labels = data.map((b) => `<div class="bar-lbl">${esc(b.label)}</div>`).join('');
  return `<div class="chart"><div class="bars" style="grid-template-columns:repeat(${data.length},1fr)">${cols}</div><div class="axis" style="grid-template-columns:repeat(${data.length},1fr)">${labels}</div><p class="cap">${esc(caption)}</p></div>`;
}

const cell = (s: string) => esc(s);
const ref = (s: string) => `<span style="white-space:nowrap">${esc(s)}</span>`;
const strong = (s: string) => `<b>${esc(s)}</b>`;

/* ──────────────────────────── Document : couverture + pages de contenu ──────────────────────────── */

function layout(opts: { title: string; blurb: string; meta: ReportMeta; footer: string; body: string }): string {
  const a = loadAssets();
  const m = opts.meta;
  const footer = `${opts.footer} · ${m.eventTitle}`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(opts.title)} · ${esc(m.eventTitle)}</title><style>
${fontCss()}
@page cover{size:A4;margin:0}
@page body{size:A4;margin:29mm 20mm 15mm 20mm;
  @top-left{content:"";width:30mm;vertical-align:top;background:url(${a.logoColor}) no-repeat -2.5mm 5.5mm/24.5mm auto,linear-gradient(${C.cyan},${C.cyan}) no-repeat 0 21.5mm/100% .3mm}
  @top-center{content:${cssString(`${m.org} · Rapport de l’événement`)};width:110mm;vertical-align:top;padding-top:11.5mm;text-align:left;font:400 7pt Poppins;color:${C.grey};background:linear-gradient(${C.cyan},${C.cyan}) no-repeat 0 21.5mm/100% .3mm}
  @top-right{content:"Usage interne";width:30mm;vertical-align:top;padding-top:11.5mm;text-align:right;font:400 7pt Poppins;color:${C.grey};background:linear-gradient(${C.cyan},${C.cyan}) no-repeat 0 21.5mm/100% .3mm}
  @bottom-left{content:${cssString(footer)};width:140mm;vertical-align:top;padding-top:4mm;font:400 7pt Poppins;color:${C.grey};border-top:.25mm solid ${C.track}}
  @bottom-right{content:"Page " counter(page);width:30mm;vertical-align:top;padding-top:4mm;text-align:right;font:400 7pt Poppins;color:${C.grey};border-top:.25mm solid ${C.track}}
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font:400 8.5pt/1.45 Poppins,sans-serif;color:${C.ink}}
.cover{page:cover;position:relative;width:210mm;height:296.5mm;overflow:hidden;background:${C.navy};color:#fff;break-after:page}
.cover .circle{position:absolute;left:-70mm;top:-70mm;width:140mm;height:140mm;border-radius:50%;background:#1b1651}
.cover .logo{position:absolute;left:13.5mm;top:21mm;width:62mm}
.cover .mark{position:absolute;left:110mm;top:134mm;width:131mm;height:160mm;overflow:hidden;opacity:.12}
.cover .mark img{position:absolute;left:-268mm;top:-48mm;width:420mm;clip-path:polygon(268mm 0,100% 0,100% 100%,286mm 100%,286mm 182.6mm,268mm 182.6mm)} /* le bouclier seul, sans le « JCI » ni la signature */
.cover .bar{position:absolute;left:20mm;top:113mm;width:14mm;height:1.1mm;background:${C.blue}}
.cover .kicker{position:absolute;left:20mm;top:118.3mm;font:400 6.5pt Poppins;letter-spacing:.03em;color:${C.cyan}}
.cover h1{position:absolute;left:20mm;top:124.6mm;width:150mm;margin:0;font:700 36pt/1.02 Poppins;color:#fff}
.cover .sub{position:absolute;left:20mm;top:0;width:150mm;font:500 15pt/1.2 Poppins;color:${C.cyan}}
.cover .blurb{position:absolute;left:20mm;width:108mm;font:400 8pt/1.55 Poppins;color:#b9bce6}
.cover .metas{position:absolute;left:20mm;right:20mm;top:248mm;border-top:.25mm solid #2d2879;padding-top:4mm;display:grid;grid-template-columns:62mm 50mm 1fr}
.cover .metas small{display:block;font:400 5.5pt Poppins;letter-spacing:.07em;color:${C.cyan};margin-bottom:1.2mm}
.cover .metas span{font:400 8pt Poppins;color:#fff}
.content{page:body}
.chapter{break-after:avoid;break-inside:avoid;margin-top:11mm}
.chapter.newpage{break-before:page;margin-top:0}
.content>.chapter:first-child{margin-top:0}
.ch-label{font:500 6.5pt Poppins;color:${C.blue};letter-spacing:.04em}
h1{font:700 22pt/1.15 Poppins;color:${C.ink};margin:.5mm 0 2mm}
.intro{font:400 8.5pt Poppins;color:${C.ink};margin-bottom:4.5mm}
h2{font:600 12pt Poppins;color:${C.h2};margin:5mm 0 1.5mm;break-after:avoid}
table{width:100%;border-collapse:collapse}
tr{break-inside:avoid}
table.kv{border-top:.5mm solid ${C.ink}}
.kv th{width:62mm;text-align:left;font-weight:400;padding:2mm 3mm;vertical-align:top}
.kv td{font-weight:600;padding:2mm 3mm;vertical-align:top}
.kv.plain td{font-weight:400}
.kv tr:nth-child(even){background:${C.band}}
.kv tr.hl{background:${C.total}}
table.data{margin-bottom:1mm}
.data thead{display:table-header-group}
.data th{background:${C.ink};color:#fff;text-align:left;font:600 7pt Poppins;padding:2.2mm 2.6mm}
.data td{padding:1.9mm 2.6mm;font-size:8pt;vertical-align:top}
.data .r{text-align:right;white-space:nowrap}
.data tbody tr:nth-child(even){background:${C.band}}
.data tr.tot{background:${C.total}!important;border-top:.4mm solid ${C.blue}}
.data tr.tot td{font-weight:500}
.data tr.empty td{text-align:center;color:${C.grey};padding:5mm}
.data b{font-weight:600}
.s-ok{color:${C.green};font-weight:700}.s-ko{color:${C.red};font-weight:700}.s-refund{color:${C.info};font-weight:700}.s-wait{color:${C.orange};font-weight:700}
.chart{break-inside:avoid;margin-top:2mm}
.bars{display:grid;gap:7mm;height:46mm;align-items:end;border-bottom:.25mm solid ${C.track};padding:0 8mm}
.bar-col{display:flex;flex-direction:column;justify-content:flex-end;height:100%;align-items:center}
.bar-val{font:600 8pt Poppins;margin-bottom:1.5mm}
.bar{width:100%;background:${C.blue};min-height:.4mm}
.axis{display:grid;gap:7mm;padding:1.5mm 8mm 0}
.bar-lbl{text-align:center;font:400 7pt Poppins;color:${C.grey}}
.cap{font:400 7.5pt Poppins;color:${C.grey};margin-top:1.5mm}
.chart-empty{margin:3mm 0;color:${C.grey};font-size:8pt}
.share{display:flex;align-items:center;gap:3mm}
.share i{display:block;width:38mm;height:2.2mm;background:${C.track};border-radius:.3mm;position:relative}
.share i b{position:absolute;left:0;top:0;bottom:0;background:${C.blue};border-radius:.3mm}
.note{break-inside:avoid;margin:5mm 0 2mm;background:${C.total};border-left:1mm solid ${C.blue};padding:3mm 4mm}
.note b{display:block;font:700 6.5pt Poppins;color:${C.h2};letter-spacing:.03em;margin-bottom:1mm}
.note p{font-size:8pt}
.small{font:400 7.5pt Poppins;color:${C.grey};margin:1.5mm 0 0}
</style></head><body>
<section class="cover">
  <div class="circle"></div>
  <div class="mark"><img src="${a.logoWhite}" alt=""></div>
  <img class="logo" src="${a.logoWhite}" alt="${esc(m.org)}">
  <div class="bar"></div><div class="kicker">RAPPORT D’ÉVÉNEMENT</div>
  <h1>${opts.title.split('\n').map(esc).join('<br>')}</h1>
  <div class="sub" id="sub">${esc(m.eventTitle)}</div>
  <div class="blurb" id="blurb">${esc(opts.blurb)}</div>
  <div class="metas"><div><small>ORGANISATION</small><span>${esc(m.org)}</span></div><div><small>DATE D’ÉDITION</small><span>${esc(m.editionDate)}</span></div><div><small>DIFFUSION</small><span>Usage interne</span></div></div>
</section>
<main class="content">${opts.body}</main>
</body></html>`;
}

/** Titre de couverture sur 1 à 2 lignes : la position du sous-titre et du texte suit le nombre de lignes. */
function coverFix(html: string, titleLines: number): string {
  const subTop = 124.6 + titleLines * 13.1 + 4.5; // mm
  return html.replace('id="sub"', `style="top:${subTop.toFixed(1)}mm"`).replace('id="blurb"', `style="top:${(subTop + 12).toFixed(1)}mm"`);
}

function build(opts: Parameters<typeof layout>[0]): string {
  return coverFix(layout(opts), opts.title.split('\n').length);
}

/* ──────────────────────────── Les quatre rapports ──────────────────────────── */

export function participantsHtml(meta: ReportMeta, d: ParticipantsReport): string {
  const rows = d.rows.map((r, i) => [String(i + 1), strong(r.name), cell(r.phone), cell(r.email)]);
  const extra = d.excluded > 0 ? `<p class="small">${int(d.excluded)} billet${d.excluded > 1 ? 's' : ''} annulé${d.excluded > 1 ? 's' : ''} ou remboursé${d.excluded > 1 ? 's' : ''} ne figure${d.excluded > 1 ? 'nt' : ''} pas dans cette liste.</p>` : '';
  return build({
    title: 'Liste des\nparticipants', meta, footer: 'Liste des participants',
    blurb: `Inscrits, coordonnées et informations de l’événement du ${meta.eventDates}${meta.eventPlace ? ` à ${meta.eventPlace}` : ''}.`,
    body: chapter(1, 'L’événement', 'Fiche récapitulative de l’événement concerné par ce rapport.')
      + h2('Informations générales') + kv(d.info, { plain: true })
      + chapter(2, 'Liste des participants', 'Noms, numéros de téléphone et adresses e-mail des participants inscrits, classés par ordre d’inscription.')
      + table([{ label: 'N°', width: '11mm' }, { label: 'Nom et prénom', width: '55mm' }, { label: 'Téléphone', width: '42mm' }, { label: 'E-mail' }], rows, { emptyText: 'Aucun participant inscrit pour le moment.' })
      + extra,
  });
}

function attendanceBilan(a: AttendanceBlock): [string, string][] {
  return [['Participants attendus', a.expectedNote], ['Entrées validées', int(a.entered)], [a.absentsLabel, int(a.absents)], ['Taux de présence', a.rate]];
}

function anomalyTable(rows: AnomalyRow[]): string {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return table([{ label: 'Type d’anomalie', width: '58mm' }, { label: 'Nombre', align: 'right', width: '20mm' }, { label: 'Détail' }],
    rows.map((r) => [cell(r.label), int(r.count), cell(r.detail)]),
    { total: ['Total', int(total), ''], emptyText: 'Aucune anomalie constatée à l’entrée.' });
}

export function ticketingHtml(meta: ReportMeta, d: TicketingReport): string {
  const modesTotal = d.modes.reduce((s, m) => s + m.net, 0);
  const modeRows = d.modes.map((m) => [cell(m.label), xof(m.net), pct(m.share, 1), `<div class="share"><i><b style="width:${Math.round(m.share * 100)}%"></b></i></div>`]);
  return build({
    title: 'Rapport de\nbilletterie', meta, footer: 'Rapport de billetterie',
    blurb: `Synthèse des ventes, des recettes et des présences de l’événement du ${meta.eventDates}.`,
    body: chapter(1, 'Synthèse des ventes', 'Vue d’ensemble des billets vendus, des recettes encaissées et du remplissage de la salle.')
      + h2('Chiffres clés')
      + kv([
        ['Capacité de l’événement', `${int(d.capacity)} places`], ['Billets vendus', d.soldNote], ['Places restantes', int(d.remaining)], ['Taux de remplissage', d.fillRate],
        ['Recettes brutes', xof(d.gross)], ['Remboursements', d.refundedTickets > 0 || d.refunded > 0 ? `${xof(d.refunded)} (${int(d.refundedTickets)} billet${d.refundedTickets > 1 ? 's' : ''})` : xof(0)], ['Recettes nettes', xof(d.net)],
      ], { strongLast: true })
      + h2('Ventes par catégorie')
      + table([{ label: 'Catégorie' }, { label: 'Prix unitaire', align: 'right' }, { label: 'Vendus', align: 'right' }, { label: 'Remboursés', align: 'right' }, { label: 'Recettes nettes', align: 'right' }],
        d.categories.map((c) => [cell(c.name), xof(c.price), int(c.sold), int(c.refunded), xof(c.net)]),
        { total: ['Total', '', int(d.categories.reduce((s, c) => s + c.sold, 0)), int(d.categories.reduce((s, c) => s + c.refunded, 0)), xof(d.categories.reduce((s, c) => s + c.net, 0))], emptyText: 'Aucune catégorie de billets.' })
      + (d.cancelledNote ? `<p class="small">${esc(d.cancelledNote)}</p>` : '')
      + h2('Évolution des ventes') + bars(d.sales, d.salesCaption, 'Aucune vente pour le moment.')
      + chapter(2, 'Recettes par mode de paiement', 'Répartition des recettes nettes selon le canal utilisé par les participants.', true)
      + table([{ label: 'Mode de paiement' }, { label: 'Montant net', align: 'right' }, { label: 'Part', align: 'right', width: '16mm' }, { label: '', width: '48mm' }], modeRows,
        { total: ['Total', xof(modesTotal), d.modes.length ? pct(1, 1) : '', ''], emptyText: 'Aucun paiement encaissé pour le moment.' })
      + chapter(3, 'Présences à l’entrée', 'Résultat des scans de billets effectués par l’équipe d’accueil le jour de l’événement.')
      + h2('Bilan des présences') + kv(attendanceBilan(d.attendance))
      + h2('Anomalies constatées') + anomalyTable(d.anomalies),
  });
}

export function attendanceHtml(meta: ReportMeta, d: AttendanceReport): string {
  const totals = d.byCategory.reduce((a, c) => ({ e: a.e + c.expected, i: a.i + c.entered, a: a.a + c.absents }), { e: 0, i: 0, a: 0 });
  return build({
    title: 'Liste des\nprésences', meta, footer: 'Liste des présences',
    blurb: `Scans valides et anomalies à l’entrée de l’événement du ${meta.eventDates}.`,
    body: chapter(1, 'Bilan des entrées', 'Résumé des scans réalisés à l’accueil le jour de l’événement.')
      + h2('Chiffres clés')
      + kv([...attendanceBilan(d), ['Anomalies constatées', int(d.anomaliesCount)], ['Premier scan', d.firstScan], ['Dernier scan', d.lastScan]])
      + h2('Présences par catégorie')
      + table([{ label: 'Catégorie' }, { label: 'Attendus', align: 'right' }, { label: 'Entrées validées', align: 'right' }, { label: d.absentsLabel, align: 'right' }, { label: 'Taux de présence', align: 'right' }],
        d.byCategory.map((c) => [cell(c.name), int(c.expected), int(c.entered), int(c.absents), c.rate]),
        { total: ['Total', int(totals.e), int(totals.i), int(totals.a), pct(totals.i, totals.e)], emptyText: 'Aucun billet émis pour le moment.' })
      + h2('Affluence à l’entrée') + bars(d.hourly, 'Entrées validées par tranche horaire.', 'Aucune entrée validée pour le moment.')
      + chapter(2, 'Scans valides', 'Participants entrés à l’événement, classés par heure de scan.', true)
      + table([{ label: 'N°', width: '11mm' }, { label: 'Heure', width: '20mm' }, { label: 'Nom et prénom' }, { label: 'Catégorie', width: '30mm' }, { label: 'Référence billet', width: '38mm' }],
        d.scans.map((s, i) => [String(i + 1), cell(s.time), strong(s.name), cell(s.category), ref(s.number)]), { emptyText: 'Aucune entrée validée pour le moment.' })
      + chapter(3, 'Anomalies à l’entrée', 'Scans refusés ou nécessitant une vérification par l’équipe d’accueil.')
      + table([{ label: 'Heure', width: '24mm' }, { label: 'Référence billet', width: '60mm' }, { label: 'Type d’anomalie' }],
        d.anomalies.map((a) => [cell(a.time), ref(a.reference), cell(a.label)]), { emptyText: 'Aucune anomalie constatée à l’entrée.' }),
  });
}

export function paymentsHtml(meta: ReportMeta, d: PaymentsReport): string {
  const sum = (k: 'orders' | 'approved' | 'refunded' | 'failed' | 'net') => d.methods.reduce((s, m) => s + m[k], 0);
  const approvedLine = `${int(d.approved)}${d.approvedRefunded > 0 ? ` (dont ${int(d.approvedRefunded)} remboursée${d.approvedRefunded > 1 ? 's' : ''})` : ''}`;
  const keyRows: [string, string][] = [
    ['Commandes FedaPay', int(d.orders)], ['Transactions approuvées', approvedLine], ['Transactions échouées ou expirées', int(d.failed)], ['Transactions en attente', int(d.pending)],
    ...(d.toRefund > 0 ? [['À rembourser (action requise)', `${int(d.toRefund)} (${xof(d.toRefundAmount)})`] as [string, string]] : []),
    ['Taux de réussite', d.successRate], ['Montant encaissé', xof(d.collected)], ['Remboursements', xof(d.refunded)], ['Montant net', xof(d.net)],
  ];
  const statusCell = (t: { status: string; tone: PaymentTone }) => `<span class="s-${t.tone}">${esc(t.status)}</span>`;
  return build({
    title: 'Journal des\npaiements', meta, footer: 'Journal des paiements',
    blurb: `Commandes et transactions FedaPay de l’événement du ${meta.eventDates}.`,
    body: chapter(1, 'Bilan des paiements', 'Résumé des commandes et des transactions réalisées en ligne via la plateforme FedaPay.')
      + h2('Chiffres clés') + kv(keyRows, { strongLast: true })
      + h2('Répartition par moyen de paiement')
      + table([{ label: 'Moyen de paiement' }, { label: 'Commandes', align: 'right' }, { label: 'Approuvées', align: 'right' }, { label: 'Remboursées', align: 'right' }, { label: 'Échouées', align: 'right' }, { label: 'Montant net', align: 'right' }],
        d.methods.map((m) => [cell(m.label), int(m.orders), int(m.approved), int(m.refunded), int(m.failed), xof(m.net)]),
        { total: ['Total', int(sum('orders')), int(sum('approved')), int(sum('refunded')), int(sum('failed')), xof(sum('net'))], emptyText: 'Aucun paiement pour le moment.' })
      + `<p class="small">Les chiffres clés ci-dessus portent uniquement sur les paiements FedaPay ; les espèces et le Mobile Money direct sont encaissés à l’accueil.</p>`
      + h2('Évolution des transactions') + bars(d.weekly, d.weeklyCaption, 'Aucune transaction approuvée pour le moment.')
      + chapter(2, 'Commandes et transactions', 'Commandes passées en ligne, classées par date, avec le statut de la transaction FedaPay.', true)
      + table([{ label: 'Date', width: '23mm' }, { label: 'Commande', width: '31mm' }, { label: 'Participant' }, { label: 'Moyen', width: '25mm' }, { label: 'Montant', align: 'right', width: '25mm' }, { label: 'Statut', width: '23mm' }],
        d.transactions.map((t) => [cell(t.date), ref(t.order), strong(t.buyer), cell(t.method), xof(t.amount), statusCell(t)]), { emptyText: 'Aucune commande en ligne pour le moment.' })
      + chapter(3, 'Remboursements', 'Transactions remboursées aux participants.')
      + table([{ label: 'Date', width: '28mm' }, { label: 'Commande', width: '34mm' }, { label: 'Participant' }, { label: 'Montant', align: 'right', width: '30mm' }],
        d.refunds.map((r) => [cell(r.date), ref(r.order), strong(r.buyer), xof(r.amount)]),
        { total: ['Total', '', '', xof(d.refunds.reduce((s, r) => s + r.amount, 0))], emptyText: 'Aucun remboursement.' })
      + (d.toRefundRows.length
        ? h2('Remboursements à effectuer') + table([{ label: 'Date', width: '24mm' }, { label: 'Commande', width: '30mm' }, { label: 'Participant' }, { label: 'Motif', width: '54mm' }, { label: 'Montant', align: 'right', width: '26mm' }],
          d.toRefundRows.map((r) => [cell(r.date), ref(r.order), strong(r.buyer), cell(r.reason), xof(r.amount)]))
        : ''),
  });
}
