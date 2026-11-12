/** Palette et utilitaires du design des billets (relevés sur la maquette fournie et sur le logo officiel). */

export const BRAND = {
  navy: '#0A2150',      // panneaux sombres (maquette)
  navyDeep: '#061230',
  ink: '#0B1230',       // texte
  muted: '#4A5675',
  logoNavy: '#100838',  // « JCI » du logo
  logoCyan: '#00A0E8',  // « Comé Excellence » du logo
  accentDefault: '#F2B83A', // or de la maquette
  paper: '#F7F9FD',
  paperEdge: '#E3E8F4',
} as const;

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Couleur invalide : ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const toHex = ([r, g, b]: [number, number, number]) => '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');

/** Mélange `a` avec `b` (t = 0 → a, t = 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a); const [br, bg, bb] = parseHex(b);
  return toHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

/** Luminance relative (WCAG), pour choisir un texte lisible sur la couleur d'accent. */
export function luminance(hex: string): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = parseHex(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export interface AccentPalette { base: string; light: string; dark: string; softBg: string; onAccent: string }

/** Déduit toutes les teintes utiles (dégradés, fonds doux, texte) de la seule couleur d'accent de l'événement. */
export function accentPalette(accent: string | null | undefined): AccentPalette {
  const base = accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent.toUpperCase() : BRAND.accentDefault;
  return {
    base,
    light: mix(base, '#FFFFFF', 0.55),
    dark: mix(base, '#000000', 0.32),
    softBg: mix(base, '#FFFFFF', 0.9),
    onAccent: luminance(base) > 0.28 ? BRAND.navyDeep : '#FFFFFF',
  };
}

export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const TZ = 'Africa/Porto-Novo';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** « 19 » + « Décembre 2026 » (heure du Bénin). */
export function formatDateParts(d: Date | null): { day: string; monthYear: string; long: string } {
  if (!d) return { day: '—', monthYear: '', long: 'Date à confirmer' };
  const day = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, day: 'numeric' }).format(d);
  const month = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, month: 'long' }).format(d);
  const year = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, year: 'numeric' }).format(d);
  return { day, monthYear: `${cap(month)} ${year}`, long: `${day} ${cap(month)} ${year}` };
}

/** « 19 h 19 » (heure du Bénin). */
export function formatTime(d: Date | null): string {
  if (!d) return '—';
  const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')} h ${get('minute')}`;
}

/** « 5 000 FCFA » avec espace insécable (présent dans la police embarquée, contrairement à l'espace fine insécable). */
export function formatPrice(xof: number): string {
  return `${new Intl.NumberFormat('fr-FR').format(xof).replace(/[\u202f\u00a0]/g, '\u00a0')}\u00a0FCFA`;
}

export const EVENT_CATEGORY_LABEL: Record<string, string> = {
  CONFERENCE: 'Conférence', FORMATION: 'Formation', ATELIER: 'Atelier', NETWORKING: 'Networking', GALA: 'Soirée de gala', AUTRE: 'Événement',
};

/** Taille de police adaptée à la longueur d'un texte (barèmes : [longueur max, taille]). */
export function fit(text: string, scale: [number, number][], fallback: number): number {
  for (const [max, size] of scale) if (text.length <= max) return size;
  return fallback;
}

/** « Koffi Ahoussou » → « Koffi A. » (visuel de partage : on ne publie pas le nom complet). */
export function shortName(first: string, last: string): string {
  const l = last.trim().charAt(0).toUpperCase();
  return l ? `${first.trim()} ${l}.` : first.trim();
}
