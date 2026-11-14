import { imageSize } from 'image-size';
import { DesignAssets } from './assets';
import { cleanText, ellipsize, fitLines, fitSize, measure, textPath, Face } from './glyphs';
import { qrPath } from './qr';
import { accentPalette, BRAND, EVENT_CATEGORY_LABEL, formatDateParts, formatPrice, formatTime } from './tokens';
import { TICKET_H as H, TICKET_W as W, TicketRenderData } from './types';

/**
 * Billet d'accès (1122 × 376 px = 297 × 99,5 mm) dessiné en SVG pur : rectangles, tracés, dégradés, images. Texte en tracés.
 * Le même dessin donne le PNG (resvg) et le PDF (pdfkit) : les deux fichiers sont identiques.
 *
 * Trois zones : affiche de l'événement avec son titre (gauche) · participant, date, heure, lieu (centre) · souche détachable avec QR code (droite).
 * Aucun texte n'est inséré comme balisage : tout passe par des tracés. Seuls les attributs suivants viennent de l'extérieur :
 * la couleur d'accent (validée en #RRGGBB par accentPalette) et l'affiche (data-URI png/jpeg, dimensions relues ici).
 */

// ── Géométrie ──
const ART_EDGE = 316;      // bord de l'affiche en haut et en bas ; la courbe avance jusqu'à ≈ 358
const ART_CTRL = 372;
const STUB_X = 908;
const PERF_X = 903;
const CX = 396;            // colonne centrale
const CW = 480;
const CR = CX + CW;        // 876
const NAVY = BRAND.navy;

const f1 = (n: number) => String(Math.round(n * 10) / 10);
const path = (d: string, attrs: string) => (d ? `<path d="${d}" ${attrs}/>` : '');

interface Dims { w: number; h: number }
const dimsCache = new Map<string, Dims | null>();
function posterDims(uri: string): Dims | null {
  const m = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(uri);
  if (!m) return null;
  const key = `${uri.length}:${uri.slice(-48)}`;
  if (dimsCache.has(key)) return dimsCache.get(key)!;
  let out: Dims | null = null;
  try { const s = imageSize(Buffer.from(m[1], 'base64')); if (s.width && s.height) out = { w: s.width, h: s.height }; } catch { /* image illisible : artwork par défaut */ }
  if (dimsCache.size > 20) dimsCache.clear();
  dimsCache.set(key, out);
  return out;
}

/**
 * Fondu de transparence sans `stop-opacity` : certains lecteurs PDF le rendent par paliers visibles.
 * On empile des rectangles (ou des disques) peu opaques dont les opacités se cumulent : le résultat est lisse et identique partout.
 */
function layers(totals: number[]): number[] {
  let prev = 0;
  return totals.map((t) => { const o = Math.max(0, 1 - (1 - t) / (1 - prev)); prev = Math.max(prev, t); return o; });
}
/** Voile de couleur sur le rectangle (x, y, w, h) : opacité `from` en haut, `to` en bas. */
function fadeV(x: number, y: number, w: number, h: number, color: string, from: number, to: number, steps = 36): string {
  const down = to >= from;
  const t = Array.from({ length: steps }, (_, k) => down ? from + (to - from) * ((k + 0.5) / steps) : to + (from - to) * ((k + 0.5) / steps));
  return layers(t).map((o, k) => {
    if (o < 0.002) return '';
    const top = down ? y + (h * k) / steps : y;
    const hh = down ? h - (h * k) / steps : h - (h * k) / steps;
    return `<rect x="${x}" y="${f1(top)}" width="${w}" height="${f1(hh)}" fill="${color}" fill-opacity="${o.toFixed(4)}"/>`;
  }).join('');
}
/** Halo : disque de rayon r, opacité `peak` au centre, nulle au bord. */
function halo(cx: number, cy: number, r: number, color: string, peak: number, steps = 10): string {
  const t = Array.from({ length: steps }, (_, k) => peak * (1 - (steps - 1 - k + 0.5) / steps) ** 1.4);
  return layers(t).map((o, k) => `<circle cx="${cx}" cy="${cy}" r="${f1(r * (1 - (steps - 1 - k) / steps))}" fill="${color}" fill-opacity="${o.toFixed(4)}"/>`).join('');
}

const ICON = {
  calendar: (c: string) => `<rect x="3" y="5" width="18" height="16" rx="3" fill="${c}"/><rect x="7" y="2.5" width="2.2" height="5" rx="1.1" fill="#fff" stroke="${c}" stroke-width="1"/><rect x="14.8" y="2.5" width="2.2" height="5" rx="1.1" fill="#fff" stroke="${c}" stroke-width="1"/><rect x="6" y="13" width="3.4" height="3" rx=".8" fill="#fff"/><rect x="10.3" y="13" width="3.4" height="3" rx=".8" fill="#fff"/><rect x="14.6" y="13" width="3.4" height="3" rx=".8" fill="#fff"/>`,
  clock: (c: string) => `<circle cx="12" cy="12" r="9.2" fill="none" stroke="${c}" stroke-width="2.4"/><path d="M12 6.8V12l3.6 2.2" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  pin: (c: string) => `<path d="M12 22s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12Z" fill="${c}"/><circle cx="12" cy="10" r="2.9" fill="#fff"/>`,
  info: (c: string, on: string) => `<circle cx="12" cy="12" r="11" fill="${c}"/><rect x="10.6" y="10.2" width="2.8" height="7.4" rx="1.2" fill="${on}"/><circle cx="12" cy="6.9" r="1.7" fill="${on}"/>`,
};
/** Icône de 24 × 24 posée en (x, y) à la taille `s`. */
const icon = (inner: string, x: number, y: number, s: number) => `<g transform="translate(${f1(x)} ${f1(y)}) scale(${f1(s / 24)})">${inner}</g>`;

/** Treillis de losanges, très discret, en bas du centre (s'estompe vers le haut à gauche). */
function lattice(color: string): string {
  const x0 = 556, x1 = 896, y0 = 186, y1 = 376, step = 15 * Math.SQRT2;
  const out: string[] = [];
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const t = ((((ax + bx) / 2) - x0) + (((ay + by) / 2) - y0)) / ((x1 - x0) + (y1 - y0));
    const fade = Math.max(0, Math.min(1, (t - 0.3) / 0.7));
    if (fade > 0.02 && Math.hypot(bx - ax, by - ay) > 4) out.push(`<path d="M${f1(ax)} ${f1(ay)}L${f1(bx)} ${f1(by)}" stroke="${color}" stroke-width="2" stroke-opacity="${(0.07 * fade).toFixed(3)}" fill="none"/>`);
  };
  for (let c = x0 + y0; c <= x1 + y1; c += step) { const a = Math.max(x0, c - y1), b = Math.min(x1, c - y0); if (a < b) add(a, c - a, b, c - b); }       // /
  for (let c = x0 - y1; c <= x1 - y0; c += step) { const a = Math.max(x0, c + y0), b = Math.min(x1, c + y1); if (a < b) add(a, a - c, b, b - c); }       // \
  return out.join('');
}

/** Garde-fou : un texte démesuré est coupé avant toute mise en page (les formulaires limitent déjà la saisie ; ceci protège le rendu). */
const clip = (s: string, max: number) => { const c = [...String(s ?? '')]; return c.length > max ? `${c.slice(0, max - 1).join('')}…` : c.join(''); };
const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function ticketSvg(input: TicketRenderData, a: DesignAssets): string {
  const d: TicketRenderData = {
    ...input,
    holderFirstName: clip(input.holderFirstName, 60), holderLastName: clip(input.holderLastName, 60),
    categoryName: clip(input.categoryName, 40), conditions: input.conditions ? clip(input.conditions, 120) : null,
    event: { ...input.event, title: clip(input.event.title, 100), venueName: clip(input.event.venueName, 100), city: clip(input.event.city, 60) },
  };
  const p = accentPalette(d.event.accentColor);
  const date = formatDateParts(d.event.startsAt);
  const time = formatTime(d.event.startsAt);
  const holder = `${d.holderFirstName} ${d.holderLastName}`.replace(/\s+/g, ' ').trim();
  const city = d.event.city.trim();
  const venue = ((d.event.venueName.trim() || 'Lieu à confirmer') + (city && !d.event.venueName.toLowerCase().includes(city.toLowerCase()) ? `, ${city}` : '')).toLocaleUpperCase('fr-FR');
  const poster = d.posterDataUri ? posterDims(d.posterDataUri) : null;
  const txt = (s: string, face: Face, size: number, x: number, y: number, fill: string, anchor: 'start' | 'middle' | 'end' = 'start', tracking = 0, extra = '') =>
    path(textPath(s, face, size, x, y, anchor, tracking), `fill="${fill}" ${extra}`);
  const cap = (size: number) => size * 0.35; // demi-hauteur des majuscules : centre une ligne sur un axe

  const body: string[] = [];

  // ── Affiche (gauche) ──
  const art: string[] = [];
  if (poster) {
    const s = Math.max(ART_CTRL / poster.w, H / poster.h);
    const w = poster.w * s, h = poster.h * s;
    art.push(`<image x="${f1((ART_CTRL - w) / 2)}" y="${f1((H - h) / 2)}" width="${f1(w)}" height="${f1(h)}" preserveAspectRatio="none" xlink:href="${d.posterDataUri}"/>`);
  } else {
    art.push(`<rect width="${ART_CTRL}" height="${H}" fill="url(#genBg)"/>`);
    art.push(halo(305, 81, 37, p.light, 0.8) + halo(64, 310, 48, p.light, 0.64) + halo(327, 277, 27, p.light, 0.56) + halo(170, 320, 20, p.light, 0.48));
  }
  art.push(fadeV(0, 0, ART_CTRL, H * 0.4, '#040C26', 0.72, 0) + fadeV(0, H * 0.5, ART_CTRL, H * 0.5, '#040C26', 0, 0.86));
  art.push(`<image x="26" y="18" width="104" height="${f1((104 * 467) / 700)}" preserveAspectRatio="none" xlink:href="${a.logoWhite}"/>`);
  // Titre de l'événement, en bas de l'affiche
  const title = fitLines(d.event.title, 'm800', [36, 32, 28, 25, 22, 19], 268, 3);
  const lh = title.size * 1.12;
  const lastBase = 336;
  const firstBase = lastBase - (title.lines.length - 1) * lh;
  if (!poster) {
    const label = EVENT_CATEGORY_LABEL[d.event.category] ?? 'Événement';
    const lw = measure(label, 'm800i', 15) + 40;
    const ly = firstBase - title.size * 0.8 - 14 - 32;
    art.push(`<rect x="30" y="${f1(ly)}" width="${f1(lw)}" height="32" rx="16" fill="url(#gold)"/>`);
    art.push(txt(label, 'm800i', 15, 30 + lw / 2, ly + 16 + cap(15), p.onAccent, 'middle'));
  }
  title.lines.forEach((l, i) => art.push(txt(l, 'm800', title.size, 30, firstBase + i * lh, '#FFFFFF')));
  body.push(`<g clip-path="url(#artClip)">${art.join('')}</g>`);
  body.push(`<path d="M${ART_EDGE} 0C${ART_CTRL} 74 ${ART_CTRL} 302 ${ART_EDGE} 376" fill="none" stroke="url(#goldV)" stroke-width="7"/>`);
  body.push(`<path d="M${ART_EDGE - 11} 0C${ART_CTRL - 14} 74 ${ART_CTRL - 14} 302 ${ART_EDGE - 11} 376" fill="none" stroke="${p.light}" stroke-opacity=".55" stroke-width="1.6"/>`);

  // ── Centre ──
  body.push(lattice(p.dark));
  body.push(txt('Nom du participant', 'm600', 13, CX, 44, BRAND.muted));
  body.push(`<rect x="${CX}" y="56" width="${CW}" height="54" rx="17" fill="url(#field)" stroke="${p.light}" stroke-width="1.5"/>`);
  const nameSize = fitSize(holder, 'm800', CW - 44, [30, 28, 26, 24, 22, 20, 18, 16, 15]);
  body.push(txt(ellipsize(holder, 'm800', nameSize, CW - 44), 'm800', nameSize, CX + 22, 83 + cap(nameSize), BRAND.ink));

  // date · heure · lieu : trois blocs séparés par un filet, largeurs selon le contenu
  const rowY = 166;
  const ICON_S = 28;
  const sep = (x: number) => `<path d="M${f1(x)} 138V194" stroke="#D5DBEA" stroke-width="1.5"/>`;
  const dayW = measure(date.day, 'm800', 30), myW = measure(date.monthYear, 'm700', 14);
  const dateTextW = Math.max(dayW, myW);
  let x = CX;
  body.push(icon(ICON.calendar(p.base), x, rowY - ICON_S / 2, ICON_S));
  body.push(txt(date.day, 'm800', 30, x + ICON_S + 10, rowY + 2, BRAND.ink));
  body.push(txt(date.monthYear, 'm700', 14, x + ICON_S + 10, rowY + 22, BRAND.ink));
  x += ICON_S + 10 + dateTextW + 14;
  body.push(sep(x)); x += 14;
  body.push(icon(ICON.clock(p.base), x, rowY - ICON_S / 2, ICON_S));
  const timeSize = 22;
  body.push(txt(time, 'm800', timeSize, x + ICON_S + 9, rowY + cap(timeSize), BRAND.ink));
  x += ICON_S + 9 + measure(time, 'm800', timeSize) + 14;
  body.push(sep(x)); x += 14;
  body.push(icon(ICON.pin(p.base), x, rowY - ICON_S / 2, ICON_S));
  const vx = x + ICON_S + 9;
  const v = fitLines(venue, 'm800', [17, 16, 15, 14, 13], CR - vx, 3);
  const vlh = v.size * 1.2;
  v.lines.forEach((l, i) => body.push(txt(l, 'm800', v.size, vx, rowY - ((v.lines.length - 1) * vlh) / 2 + i * vlh + cap(v.size), BRAND.ink)));

  // catégorie + prix
  const catY = 220, catH = 46;
  const catSize = fitSize(d.categoryName, 'm800i', 170, [23, 20, 18, 16, 14]);
  const catText = ellipsize(d.categoryName, 'm800i', catSize, 170);
  const ribW = Math.min(240, measure(catText, 'm800i', catSize) + 66);
  body.push(`<path d="M${CX} ${catY + catH / 2}L${CX + 16} ${catY}H${CX + ribW}V${catY + catH}H${CX + 16}Z" fill="url(#goldH)"/>`);
  body.push(txt(catText, 'm800i', catSize, CX + 32, catY + catH / 2 + cap(catSize), p.onAccent));
  const price = formatPrice(d.priceXof);
  const priceSize = fitSize(price, 'm800', 200, [22, 20, 18]);
  const priceW = measure(price, 'm800', priceSize) + 46;
  body.push(`<rect x="${CX + ribW - 20}" y="${catY}" width="${f1(priceW)}" height="${catH}" rx="${catH / 2}" fill="url(#priceG)"/>`);
  body.push(txt(price, 'm800', priceSize, CX + ribW - 20 + priceW / 2, catY + catH / 2 + cap(priceSize), '#FFFFFF', 'middle'));

  // consigne
  const noteY = 290, noteH = 56;
  body.push(`<rect x="${CX}" y="${noteY}" width="${CW}" height="${noteH}" rx="14" fill="url(#note)" stroke="${p.light}" stroke-width="1.5"/>`);
  body.push(icon(ICON.info(p.base, p.onAccent), CX + 16, noteY + noteH / 2 - 13, 26));
  const nx = CX + 16 + 26 + 12, nw = CR - 14 - nx;
  const l1 = 'Présentez ce billet à l’entrée (version numérique ou imprimée).', l2 = 'Ce billet est personnel et non transférable.';
  const nSize = fitSize(l1, 'm600', nw, [12.5, 12, 11.5, 11, 10.5]);
  const lines: { t: string; face: Face }[] = [{ t: l1, face: 'm600' }, { t: l2, face: 'm600' }];
  if (d.conditions) lines.push({ t: ellipsize(d.conditions, 'm800', nSize, nw), face: 'm800' });
  const nlh = nSize * 1.3;
  lines.forEach((l, i) => body.push(txt(l.t, l.face, nSize, nx, noteY + noteH / 2 - ((lines.length - 1) * nlh) / 2 + i * nlh + cap(nSize), BRAND.ink)));

  // ── Souche ──
  const sx = STUB_X + 107; // axe de la souche
  const stub: string[] = [];
  stub.push(`<rect x="${STUB_X}" y="0" width="${W - STUB_X}" height="${H}" fill="url(#stubBg)"/>`);
  stub.push(`<image x="${STUB_X + 55}" y="16" width="104" height="${f1((104 * 467) / 700)}" preserveAspectRatio="none" xlink:href="${a.logoWhite}"/>`);
  stub.push(`<path d="M${STUB_X + 19} 109L${STUB_X + 32} 92H${STUB_X + 163}L${STUB_X + 176} 109L${STUB_X + 163} 126H${STUB_X + 32}Z" fill="url(#goldH)"/>`);
  const sCat = fitSize(d.categoryName, 'm800i', 138, [17, 14, 12, 10.5]);
  stub.push(txt(ellipsize(d.categoryName, 'm800i', sCat, 138), 'm800i', sCat, sx, 109 + cap(sCat), p.onAccent, 'middle'));
  stub.push(`<rect x="${STUB_X + 19}" y="134" width="176" height="40" rx="12" fill="#FFFFFF" fill-opacity=".05" stroke="${p.base}" stroke-width="2"/>`);
  const sPrice = fitSize(price, 'm800', 156, [19, 17, 15]);
  stub.push(txt(price, 'm800', sPrice, sx, 154 + cap(sPrice), '#FFFFFF', 'middle'));
  const st = fitLines(d.event.title, 'm700i', [14, 12, 10.5], 186, 2);
  st.lines.forEach((l, i) => stub.push(txt(l, 'm700i', st.size, sx, 182 + st.size * 0.95 + i * st.size * 1.14, p.light, 'middle')));
  stub.push(`<rect x="${sx - 54}" y="222" width="108" height="108" rx="13" fill="#FFFFFF"/>`);
  stub.push(path(qrPath(d.qrUrl, sx - 45, 231, 90), `fill="${BRAND.ink}" shape-rendering="crispEdges"`));
  stub.push(txt(d.number, 'm700', 10.5, sx, 348, '#FFFFFF', 'middle', 0.3));
  stub.push(`<g transform="translate(${W - 64} ${H - 56})"><path d="M64 14C46 22 30 36 18 56" fill="none" stroke="${p.base}" stroke-opacity=".95" stroke-width="5"/><path d="M64 30C52 36 42 44 34 56" fill="none" stroke="${p.light}" stroke-opacity=".5" stroke-width="2"/></g>`);
  body.push(stub.join(''));
  body.push(`<path d="M${PERF_X} 20V356" stroke="#AEB8D6" stroke-width="2" stroke-dasharray="5 4" fill="none"/>`);

  // Pièces du billet
  const defs = `<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".6" stop-color="${BRAND.paper}"/><stop offset="1" stop-color="#EEF2FA"/></linearGradient>
<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.light}"/><stop offset=".48" stop-color="${p.base}"/><stop offset="1" stop-color="${p.dark}"/></linearGradient>
<linearGradient id="goldV" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${H}"><stop offset="0" stop-color="${p.light}"/><stop offset=".5" stop-color="${p.base}"/><stop offset="1" stop-color="${p.dark}"/></linearGradient>
<linearGradient id="goldH" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${p.dark}"/><stop offset=".22" stop-color="${p.base}"/><stop offset=".52" stop-color="${p.light}"/><stop offset=".78" stop-color="${p.base}"/><stop offset="1" stop-color="${p.dark}"/></linearGradient>
<linearGradient id="priceG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#123A82"/><stop offset="1" stop-color="${NAVY}"/></linearGradient>
<linearGradient id="field" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF9EC"/><stop offset="1" stop-color="${p.softBg}"/></linearGradient>
<linearGradient id="note" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFCF4"/><stop offset="1" stop-color="${p.softBg}"/></linearGradient>
<linearGradient id="stubBg" x1="0.4" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="#0E2F6B"/><stop offset=".46" stop-color="${NAVY}"/><stop offset="1" stop-color="${BRAND.navyDeep}"/></linearGradient>
<radialGradient id="genBg" cx=".18" cy=".28" r="1"><stop offset="0" stop-color="#18448A"/><stop offset=".46" stop-color="${NAVY}"/><stop offset="1" stop-color="${BRAND.navyDeep}"/></radialGradient>
<clipPath id="tk"><rect x="0" y="0" width="${W}" height="${H}" rx="22"/></clipPath>
<clipPath id="artClip"><path d="M0 0H${ART_EDGE}C${ART_CTRL} 74 ${ART_CTRL} 302 ${ART_EDGE} 376H0Z"/></clipPath>
</defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<title>${xmlEsc(`Billet ${d.number}`)}</title>
${defs}
<rect width="${W}" height="${H}" fill="#FFFFFF"/>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="22" fill="url(#bg)" stroke="${BRAND.paperEdge}"/>
<g clip-path="url(#tk)">${body.join('\n')}</g>
<circle cx="${STUB_X}" cy="0" r="13" fill="#FFFFFF"/><circle cx="${STUB_X}" cy="${H}" r="13" fill="#FFFFFF"/><circle cx="${W}" cy="190" r="15" fill="#FFFFFF"/>
</svg>`;
}
