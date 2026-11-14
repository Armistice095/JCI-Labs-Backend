import { renderAsync } from '@resvg/resvg-js';
import { imageSize } from 'image-size';
import { encode } from 'jpeg-js';

/**
 * Image d'aperçu des liens partagés (WhatsApp, Facebook, Telegram…) : 1200 × 630 px, JPEG léger.
 *
 * Pourquoi : ces applications ignorent l'image d'aperçu quand elle est trop lourde (au-delà de 300 à 600 Ko environ) :
 * le lien s'affiche alors sans image. Une affiche de 2 Mo n'a donc aucune chance. L'affiche d'origine reste inchangée pour la page ;
 * on en tire ici une version légère. L'affiche est entière (jamais rognée), posée sur son propre fond flouté et assombri.
 */
export const SHARE_W = 1200;
export const SHARE_H = 630;
const TARGET_BYTES = 220 * 1024; // sous le seuil de confort de WhatsApp

const dataUri = (b: Buffer, mime: string) => `data:${mime};base64,${b.toString('base64')}`;

export async function buildShareImage(poster: Buffer, mime: 'image/png' | 'image/jpeg'): Promise<Buffer> {
  const { width, height } = imageSize(poster);
  if (!width || !height) throw new Error('Dimensions de l’affiche illisibles');
  const uri = dataUri(poster, mime);
  // arrière-plan : l'affiche remplit tout le cadre (rognée), floue ; premier plan : l'affiche entière, centrée
  const cover = Math.max(SHARE_W / width, SHARE_H / height) * 1.2; // 20 % de marge : les bords floutés sortent du cadre
  const fit = Math.min(SHARE_W / width, SHARE_H / height);
  const fw = width * fit, fh = height * fit;
  const fx = (SHARE_W - fw) / 2, fy = (SHARE_H - fh) / 2;
  const r = (n: number) => Math.round(n * 10) / 10;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SHARE_W}" height="${SHARE_H}" viewBox="0 0 ${SHARE_W} ${SHARE_H}">
<defs><filter id="b" filterUnits="userSpaceOnUse" x="-300" y="-300" width="${SHARE_W + 600}" height="${SHARE_H + 600}"><feGaussianBlur stdDeviation="26"/></filter><clipPath id="c"><rect width="${SHARE_W}" height="${SHARE_H}"/></clipPath></defs>
<rect width="${SHARE_W}" height="${SHARE_H}" fill="#06122E"/>
<g clip-path="url(#c)"><image x="${r((SHARE_W - width * cover) / 2)}" y="${r((SHARE_H - height * cover) / 2)}" width="${r(width * cover)}" height="${r(height * cover)}" preserveAspectRatio="none" filter="url(#b)" xlink:href="${uri}"/></g>
<rect width="${SHARE_W}" height="${SHARE_H}" fill="#06122E" fill-opacity=".45"/>
<image x="${r(fx)}" y="${r(fy)}" width="${r(fw)}" height="${r(fh)}" preserveAspectRatio="none" xlink:href="${uri}"/>
</svg>`;
  const img = await renderAsync(svg, { fitTo: { mode: 'width', value: SHARE_W }, font: { loadSystemFonts: false } });
  const rgba = Buffer.from(img.pixels);
  let out = Buffer.alloc(0);
  for (const quality of [82, 74, 66, 58, 50]) {
    out = Buffer.from(encode({ data: rgba, width: img.width, height: img.height }, quality).data);
    if (out.length <= TARGET_BYTES) break;
  }
  return out;
}
