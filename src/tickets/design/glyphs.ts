import * as fontkit from 'fontkit';
import { join } from 'node:path';
import { assetsDir } from './assets';

/**
 * Texte du billet converti en tracés vectoriels.
 *
 * Pourquoi : le même dessin SVG sert au PNG (resvg) et au PDF (pdfkit). Avec des tracés, aucune police n'est cherchée à l'exécution :
 * le texte est identique dans les deux fichiers, sur n'importe quel serveur, et il n'y a rien à installer.
 * Les mesures (largeur d'un nom, retours à la ligne) viennent des mêmes polices : ce qu'on mesure est ce qu'on dessine.
 */

export type Face = 'm500' | 'm600' | 'm700' | 'm800' | 'm700i' | 'm800i';

const FILES: Record<Face, string> = {
  m500: 'montserrat-latin-500-normal.woff2',
  m600: 'montserrat-latin-600-normal.woff2',
  m700: 'montserrat-latin-700-normal.woff2',
  m800: 'montserrat-latin-800-normal.woff2',
  m700i: 'montserrat-latin-700-italic.woff2',
  m800i: 'montserrat-latin-800-italic.woff2',
};

type Font = fontkit.Font;
const fonts = new Map<Face, Font>();

/** Charge les polices (une seule fois) : à appeler au démarrage pour que le premier billet n'attende rien. */
export function loadFaces(): void {
  for (const face of Object.keys(FILES) as Face[]) {
    if (fonts.has(face)) continue;
    const f = fontkit.openSync(join(assetsDir(), 'fonts', FILES[face]));
    if ('fonts' in f) throw new Error(`Collection de polices inattendue : ${FILES[face]}`);
    fonts.set(face, f);
  }
}
const font = (face: Face): Font => { if (!fonts.size) loadFaces(); return fonts.get(face)!; };

/** Remplace les caractères absents de la police (emoji, alphabets non latins) : lettre de base si possible, sinon ils sont ignorés. */
function printable(text: string, f: Font): string {
  let out = '';
  for (const ch of text.normalize('NFC').replace(/[\r\n\t]+/g, ' ')) {
    const cp = ch.codePointAt(0)!;
    if (f.hasGlyphForCodePoint(cp)) { out += ch; continue; }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (base && [...base].every((b) => f.hasGlyphForCodePoint(b.codePointAt(0)!))) out += base;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Largeur d'un texte, en pixels du billet. `tracking` : espacement ajouté entre les lettres (px). */
export function measure(text: string, face: Face, size: number, tracking = 0): number {
  const f = font(face);
  const t = printable(text, f);
  if (!t) return 0;
  return (f.layout(t).advanceWidth * size) / f.unitsPerEm + tracking * Math.max(0, [...t].length - 1);
}

const r2 = (n: number) => String(Math.round(n * 100) / 100);

/** Tracé SVG (attribut `d`) d'un texte dont la ligne de base est à `y`. `anchor` : alignement horizontal autour de `x`. */
export function textPath(text: string, face: Face, size: number, x: number, y: number, anchor: 'start' | 'middle' | 'end' = 'start', tracking = 0): string {
  const f = font(face);
  const t = printable(text, f);
  if (!t) return '';
  const run = f.layout(t);
  const k = size / f.unitsPerEm;
  const total = (run.advanceWidth * k) + tracking * Math.max(0, run.glyphs.length - 1);
  let pen = anchor === 'start' ? x : anchor === 'middle' ? x - total / 2 : x - total;
  const d: string[] = [];
  run.glyphs.forEach((g, i) => {
    const pos = run.positions[i];
    const ox = pen + pos.xOffset * k; const oy = y - pos.yOffset * k;
    for (const c of g.path.commands) {
      const a = c.args;
      const X = (v: number) => r2(ox + v * k); const Y = (v: number) => r2(oy - v * k);
      switch (c.command) {
        case 'moveTo': d.push(`M${X(a[0])} ${Y(a[1])}`); break;
        case 'lineTo': d.push(`L${X(a[0])} ${Y(a[1])}`); break;
        case 'quadraticCurveTo': d.push(`Q${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])}`); break;
        case 'bezierCurveTo': d.push(`C${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])} ${X(a[4])} ${Y(a[5])}`); break;
        case 'closePath': d.push('Z'); break;
      }
    }
    pen += pos.xAdvance * k + tracking;
  });
  return d.join('');
}

/** Coupe un texte trop long et ajoute « … » (recherche par dichotomie : rapide même sur un texte démesuré). */
export function ellipsize(text: string, face: Face, size: number, maxW: number): string {
  const t = printable(text, font(face));
  if (measure(t, face, size) <= maxW) return t;
  const chars = [...t];
  let lo = 0, hi = chars.length - 1; // plus grand préfixe qui tient avec « … »
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${chars.slice(0, mid).join('').trimEnd()}…`, face, size) <= maxW) lo = mid; else hi = mid - 1;
  }
  return `${chars.slice(0, Math.max(1, lo)).join('').trimEnd()}…`;
}

/** Plus grande taille (parmi `sizes`, de la plus grande à la plus petite) pour laquelle le texte tient sur `maxW` ; à défaut, la plus petite. */
export function fitSize(text: string, face: Face, maxW: number, sizes: number[]): number {
  return sizes.find((s) => measure(text, face, s) <= maxW) ?? sizes[sizes.length - 1];
}

/** Retour à la ligne par mots, au plus `maxLines` lignes ; la dernière est abrégée par « … » si le texte ne tient pas. */
export function wrap(text: string, face: Face, size: number, maxW: number, maxLines: number): string[] {
  const words = printable(text, font(face)).split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (measure(next, face, size) <= maxW) { cur = next; continue; }
    if (lines.length === maxLines - 1) return [...lines, ellipsize([cur, ...words.slice(i)].filter(Boolean).join(' '), face, size, maxW)];
    if (cur) { lines.push(cur); cur = ''; i--; continue; } // le mot est réessayé sur la ligne suivante
    lines.push(ellipsize(words[i], face, size, maxW));      // un mot seul plus large que la ligne
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Le texte tel qu'il sera dessiné (caractères non gérés retirés, espaces nettoyés). */
export function cleanText(text: string, face: Face): string { return printable(text, font(face)); }

/** Plus grande taille pour laquelle tout le texte tient en `maxLines` lignes, sans abréviation ; à défaut, la plus petite taille avec « … ». */
export function fitLines(text: string, face: Face, sizes: number[], maxW: number, maxLines: number): { size: number; lines: string[] } {
  const clean = cleanText(text, face);
  for (const size of sizes) {
    const lines = wrap(clean, face, size, maxW, maxLines);
    if (lines.join(' ') === clean) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  return { size, lines: wrap(clean, face, size, maxW, maxLines) };
}
