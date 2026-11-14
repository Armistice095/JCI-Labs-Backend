import QRCode from 'qrcode';

/**
 * QR code vectoriel : un seul tracé SVG, net à l'impression, en capture d'écran et après compression WhatsApp.
 * Niveau de correction Q (≈ 25 %) : tolère salissures et reflets. La « zone de silence » est assurée par le cadre blanc du billet.
 * Les carrés noirs d'une même ligne sont fusionnés : tracé court, pas de fines coutures entre modules.
 */
export function qrPath(text: string, x: number, y: number, side: number): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'Q' });
  const n = qr.modules.size;
  const u = side / n;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const d: string[] = [];
  for (let row = 0; row < n; row++) {
    let col = 0;
    while (col < n) {
      if (!qr.modules.get(row, col)) { col++; continue; }
      const start = col;
      while (col < n && qr.modules.get(row, col)) col++;
      d.push(`M${r(x + start * u)} ${r(y + row * u)}h${r((col - start) * u)}v${r(u)}h${r(-(col - start) * u)}z`);
    }
  }
  return d.join('');
}

/** URL encodée dans le QR : un jeton aléatoire de 128 bits, jamais de donnée personnelle. */
export const ticketQrUrl = (baseUrl: string, qrToken: string) => `${baseUrl.replace(/\/+$/, '')}/${qrToken}`;
