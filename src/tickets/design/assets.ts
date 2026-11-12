import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Fonctionne depuis src/ (tests, ts-node) comme depuis dist/ : les ressources sont à la racine du projet.
const ROOT = join(__dirname, '..', '..', '..', ...(__dirname.includes(`${join('dist')}`) ? ['..'] : []));
const dir = (() => {
  for (const base of [join(__dirname, '..', '..', '..'), join(__dirname, '..', '..', '..', '..'), process.cwd()]) {
    try { readFileSync(join(base, 'assets', 'logo.png')); return join(base, 'assets'); } catch { /* essai suivant */ }
  }
  throw new Error(`Dossier assets/ introuvable (racine : ${ROOT})`);
})();

const b64 = (file: string) => readFileSync(join(dir, file)).toString('base64');

export interface DesignAssets { logoColor: string; logoWhite: string; fontCss: string }

const FONTS: { weight: number; style: 'normal' | 'italic'; file: string }[] = [
  { weight: 500, style: 'normal', file: 'montserrat-latin-500-normal.woff2' },
  { weight: 600, style: 'normal', file: 'montserrat-latin-600-normal.woff2' },
  { weight: 700, style: 'normal', file: 'montserrat-latin-700-normal.woff2' },
  { weight: 800, style: 'normal', file: 'montserrat-latin-800-normal.woff2' },
  { weight: 700, style: 'italic', file: 'montserrat-latin-700-italic.woff2' },
  { weight: 800, style: 'italic', file: 'montserrat-latin-800-italic.woff2' },
];

let cached: DesignAssets | null = null;

/** Logo et polices en data-URI : le rendu n'a besoin d'aucun accès réseau. */
export function loadAssets(): DesignAssets {
  cached ??= {
    logoColor: `data:image/png;base64,${b64('logo.png')}`,
    logoWhite: `data:image/png;base64,${b64('logo-white.png')}`,
    fontCss: FONTS.map((f) => `@font-face{font-family:'Montserrat';font-weight:${f.weight};font-style:${f.style};src:url(data:font/woff2;base64,${b64(`fonts/${f.file}`)}) format('woff2');}`).join('\n'),
  };
  return cached;
}
