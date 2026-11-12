import QRCode from 'qrcode';

/**
 * QR code vectoriel (SVG) : reste net à l'impression, en capture d'écran et après compression WhatsApp.
 * Niveau de correction Q (≈ 25 %) : tolère salissures et reflets. Marge intégrée : la « zone de silence » est assurée par le cadre blanc du gabarit.
 */
export async function qrSvg(text: string, darkColor = '#0B1230'): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'Q', margin: 0, color: { dark: darkColor, light: '#0000' } });
  return svg.replace(/<svg /, '<svg shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet" ');
}

/** URL encodée dans le QR : un jeton aléatoire de 128 bits, jamais de donnée personnelle. */
export const ticketQrUrl = (baseUrl: string, qrToken: string) => `${baseUrl.replace(/\/+$/, '')}/${qrToken}`;
