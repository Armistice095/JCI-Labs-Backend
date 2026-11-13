import { addDays, utcToLocalParts } from '../common/time';

const NBSP = '\u00A0'; // espace insécable
const MONTHS_LONG = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/** Texte inséré dans du HTML : les noms viennent de formulaires publics, rien n'est jamais interprété comme du balisage. */
export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Texte inséré dans une chaîne CSS (`content: "…"`) à l'intérieur d'un bloc <style> : guillemets, barres obliques et chevrons neutralisés. */
export function cssString(v: string): string {
  return `"${v.replace(/[\\"<>&\r\n]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
}

/** 594000 → « 594 000 XOF » (espaces insécables : le montant ne se coupe jamais en fin de ligne). */
export function xof(n: number): string {
  return `${int(n)}${NBSP}XOF`;
}

export function int(n: number): string {
  const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return n < 0 ? `-${s}` : s;
}

export function pct(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}${NBSP}%` : `0${NBSP}%`;
}

/** Le Bénin est en UTC+1 toute l'année : toutes les dates des rapports sont en heure locale. */
const parts = (d: Date) => { const p = utcToLocalParts(d); const [y, m, day] = p.date.split('-').map(Number); return { y, m, d: day, time: p.time, iso: p.date }; };

/** 13 novembre 2026 */
export function dateLong(d: Date): string { const p = parts(d); return `${p.d}${p.d === 1 ? 'er' : ''} ${MONTHS_LONG[p.m - 1]} ${p.y}`; }
/** 5 oct. 2026 */
export function dateShort(d: Date): string { const p = parts(d); return `${p.d} ${MONTHS_SHORT[p.m - 1]} ${p.y}`; }
/** 08h06 */
export function timeFr(d: Date): string { return parts(d).time.replace(':', 'h'); }

/** « 14 novembre 2026 », ou « 14 au 15 novembre 2026 » / « 30 novembre au 2 décembre 2026 » pour un événement sur plusieurs jours. */
export function eventDates(start: Date | null, end: Date | null): string {
  if (!start) return 'Date à confirmer';
  const a = parts(start);
  const b = end ? parts(end) : null;
  if (!b || b.iso === a.iso) return dateLong(start);
  const ad = `${a.d}${a.d === 1 ? 'er' : ''}`; const bd = `${b.d}${b.d === 1 ? 'er' : ''}`;
  if (a.y === b.y && a.m === b.m) return `${ad} au ${bd} ${MONTHS_LONG[b.m - 1]} ${b.y}`;
  if (a.y === b.y) return `${ad} ${MONTHS_LONG[a.m - 1]} au ${bd} ${MONTHS_LONG[b.m - 1]} ${b.y}`;
  return `${dateLong(start)} au ${dateLong(end!)}`;
}

/** 08h00 à 17h00 */
export function eventHours(start: Date | null, end: Date | null): string {
  if (!start) return '—';
  return end ? `${timeFr(start)} à ${timeFr(end)}` : timeFr(start);
}

/** +2290195789513 → « +229 01 95 78 95 13 » (numéros béninois à 10 chiffres) ; autres formats inchangés. */
export function phoneFr(e164: string | null | undefined): string {
  if (!e164) return '—';
  const m = /^\+229(\d{10})$/.exec(e164);
  return m ? `+229 ${m[1].replace(/(\d{2})(?=\d)/g, '$1 ')}` : e164;
}

export interface Bar { label: string; value: number }

/** Découpe une série de dates en tranches de 7 jours (puis 14, 28, 56 jours si la période est longue) : au plus 12 barres. */
export function bucketize(dates: Date[], from?: Date | null, to: Date = new Date()): { bars: Bar[]; days: number } {
  if (!dates.length) return { bars: [], days: 7 };
  const locals = dates.map((d) => parts(d).iso).sort();
  const first = from ? [parts(from).iso, locals[0]].sort()[0] : locals[0];
  const last = [locals[locals.length - 1], parts(to).iso].sort().pop()!;
  const span = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;
  const days = [7, 14, 28, 56].find((d) => Math.ceil(span / d) <= 12) ?? 56;
  const n = Math.ceil(span / days);
  const counts = new Array<number>(n).fill(0);
  for (const iso of locals) counts[Math.min(n - 1, Math.floor((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000 / days))]++;
  const bars = counts.map((value, i) => {
    const s = addDays(first, i * days); const e = addDays(first, i * days + days - 1);
    return { label: rangeLabel(s, e), value };
  });
  return { bars, days };
}

/** 5–11 oct. · 26 oct.–1 nov. · 29 déc.–4 janv. */
function rangeLabel(a: string, b: string): string {
  const [, am, ad] = a.split('-').map(Number); const [, bm, bd] = b.split('-').map(Number);
  return am === bm ? `${ad}–${bd}${NBSP}${MONTHS_SHORT[bm - 1]}` : `${ad}${NBSP}${MONTHS_SHORT[am - 1]}–${bd}${NBSP}${MONTHS_SHORT[bm - 1]}`;
}

export function weekCaption(what: string, days: number): string {
  const per = days === 7 ? 'par semaine' : `par tranche de ${days} jours`;
  return `${what} ${per} depuis l’ouverture de la billetterie.`;
}

/** Entrées par heure : 4 tranches d'une heure à partir du premier scan, puis « Après Xh ». */
export function hourlyBars(scans: Date[]): Bar[] {
  if (!scans.length) return [];
  const hours = scans.map((d) => Number(parts(d).time.slice(0, 2)));
  const h0 = Math.min(...hours);
  const h = (n: number) => String(n).padStart(2, '0');
  const bars: Bar[] = [0, 1, 2, 3].map((i) => ({ label: `${h(h0 + i)}h–${h(h0 + i + 1)}h`, value: hours.filter((x) => x === h0 + i).length }));
  const after = hours.filter((x) => x >= h0 + 4).length;
  bars.push({ label: `Après ${h(h0 + 4)}h`, value: after });
  return bars;
}

/** Nom de fichier : lettres, chiffres et tirets seulement. */
export function fileSafe(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'evenement';
}
