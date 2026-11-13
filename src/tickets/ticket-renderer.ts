import { Injectable, OnModuleInit } from '@nestjs/common';
import { renderAsync } from '@resvg/resvg-js';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { loadAssets } from './design/assets';
import { loadFaces } from './design/glyphs';
import { ticketSvg } from './design/ticket-svg';
import { TICKET_H, TICKET_W, TicketRenderData } from './design/types';

export interface RenderedTicket { pdf: Buffer; png: Buffer }

const PDF_W = 841.89; // 297 mm en points
const PDF_H = (PDF_W * TICKET_H) / TICKET_W;

/**
 * Fabrique les fichiers d'un billet sans navigateur : un dessin SVG (design/ticket-svg.ts), puis
 *  - PNG haute définition (2×) par resvg, dans un fil d'exécution à part (ne bloque pas l'API) ;
 *  - PDF vectoriel (297 × 99,5 mm) par pdfkit : QR code et textes nets à l'impression.
 * Quelques dizaines de millisecondes par billet, quelques Mo de mémoire : l'achat n'attend plus Chromium.
 */
@Injectable()
export class TicketRenderer implements OnModuleInit {
  onModuleInit() { loadFaces(); loadAssets(); } // polices lues au démarrage : le premier billet n'attend rien

  async render(data: TicketRenderData): Promise<RenderedTicket> {
    const svg = ticketSvg(data, loadAssets());
    const [png, pdf] = await Promise.all([this.png(svg), this.pdf(svg, data.number)]);
    return { png, pdf };
  }

  private async png(svg: string): Promise<Buffer> {
    const r = await renderAsync(svg, { fitTo: { mode: 'width', value: TICKET_W * 2 }, font: { loadSystemFonts: false }, background: '#FFFFFF' });
    return Buffer.from(r.asPng());
  }

  private pdf(svg: string, number: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: [PDF_W, PDF_H], margin: 0, info: { Title: `Billet ${number}`, Author: 'JCI Comé Excellence', Producer: 'JCI Labs' } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      try {
        SVGtoPDF(doc, svg, 0, 0, { width: PDF_W, height: PDF_H, preserveAspectRatio: 'none', assumePt: false });
        doc.end();
      } catch (e) { reject(e); }
    });
  }
}
