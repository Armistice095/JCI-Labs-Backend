import { Inject, Injectable, Logger } from '@nestjs/common';
import { FileKind } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { loadAssets } from './design/assets';
import { qrSvg, ticketQrUrl } from './design/qr';
import { shareHtml } from './design/share-html';
import { ticketHtml } from './design/ticket-html';
import { TicketRenderData } from './design/types';
import { RendererService } from './renderer.service';

/** À incrémenter quand le design change : les billets déjà générés restent valides, les nouveaux utilisent la nouvelle version. */
export const TEMPLATE_VERSION = 1;

export type FileKindParam = 'pdf' | 'image' | 'share';
export const FILE_KINDS: Record<FileKindParam, { kind: FileKind; mime: string; ext: string; prefix: string }> = {
  pdf: { kind: 'TICKET_PDF', mime: 'application/pdf', ext: 'pdf', prefix: 'Billet' },
  image: { kind: 'TICKET_IMAGE', mime: 'image/png', ext: 'png', prefix: 'Billet' },
  share: { kind: 'SHARE_VISUAL', mime: 'image/jpeg', ext: 'jpg', prefix: 'Partage' },
};
const SIGNED_TTL = 900;                // 15 min
const MAX_POSTER_BYTES = 4 * 1024 * 1024;

export interface TicketUrls { pdfUrl: string; imageUrl: string; shareVisualUrl: string }

@Injectable()
export class TicketFilesService {
  private readonly log = new Logger(TicketFilesService.name);
  private readonly urlCache = new Map<string, { url: string; exp: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseAdminService,
    private readonly renderer: RendererService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private bucket(name: string) { return this.supabase.client.storage.from(name); }

  /** Génère les fichiers manquants d'un billet (idempotent). Un échec de rendu lève une erreur : le job sera rejoué. */
  async ensureTicketFiles(ticketId: string): Promise<{ generated: number }> {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { event: { include: { posters: { orderBy: [{ isCover: 'desc' }, { position: 'asc' }], take: 1 } } }, orderItem: true, category: true },
    });
    if (!t) return { generated: 0 };
    const have = new Set((await this.prisma.generatedFile.findMany({ where: { ticketId, templateVersion: TEMPLATE_VERSION }, select: { kind: true } })).map((f) => f.kind));
    const needTicket = !have.has('TICKET_PDF') || !have.has('TICKET_IMAGE');
    const needShare = !have.has('SHARE_VISUAL');
    if (!needTicket && !needShare) return { generated: 0 };

    const base = this.env.TICKET_QR_BASE_URL ?? `${this.env.PUBLIC_WEB_URL}/billet`;
    const data: TicketRenderData = {
      number: t.number, qrUrl: ticketQrUrl(base, t.qrToken),
      holderFirstName: t.holderFirstName, holderLastName: t.holderLastName,
      categoryName: t.category.name, priceXof: t.orderItem.unitPriceXof, // prix payé, pas le prix actuel de la catégorie
      conditions: t.category.conditions,
      event: {
        title: t.event.title, category: t.event.category, startsAt: t.event.startsAt, venueName: t.event.venueName, city: t.event.city,
        accentColor: t.event.accentColor, publicUrl: `${this.env.PUBLIC_WEB_URL}/evenements/${t.event.slug}`,
      },
      posterDataUri: await this.loadPoster(t.event.posters[0]),
    };
    const assets = loadAssets();
    const rows: { kind: FileKind; storagePath: string; mime: string; sizeBytes: number }[] = [];
    const dir = `${t.eventId}/${t.id}`;
    const put = async (key: FileKindParam, buf: Buffer) => {
      const k = FILE_KINDS[key];
      const storagePath = `${dir}/${t.number}-v${TEMPLATE_VERSION}.${k.ext}`;
      const { error } = await this.bucket(this.env.TICKETS_BUCKET).upload(storagePath, buf, { contentType: k.mime, upsert: true, cacheControl: '3600' });
      if (error) throw new Error(`Stockage ${key} : ${error.message}`);
      rows.push({ kind: k.kind, storagePath, mime: k.mime, sizeBytes: buf.length });
    };

    if (needTicket) {
      const r = await this.renderer.renderTicket(ticketHtml(data, assets, await qrSvg(data.qrUrl)));
      await put('pdf', r.pdf); await put('image', r.png);
    }
    if (needShare) await put('share', await this.renderer.renderShare(shareHtml(data, assets)));

    await this.prisma.generatedFile.createMany({
      data: rows.map((r) => ({ kind: r.kind, ticketId, eventId: t.eventId, bucket: this.env.TICKETS_BUCKET, storagePath: r.storagePath, mime: r.mime, sizeBytes: r.sizeBytes, templateVersion: TEMPLATE_VERSION })),
      skipDuplicates: true,
    });
    return { generated: rows.length };
  }

  async ensureOrderFiles(orderId: string): Promise<number> {
    const tickets = await this.prisma.ticket.findMany({ where: { orderId }, orderBy: { number: 'asc' }, select: { id: true } });
    let n = 0;
    for (const t of tickets) n += (await this.ensureTicketFiles(t.id)).generated;
    return n;
  }

  /** Affiche de l'événement en data-URI (null = artwork généré). Ne bloque jamais l'émission d'un billet. */
  private async loadPoster(p: { storagePath: string; mime: string } | undefined): Promise<string | null> {
    if (!p) return null;
    try {
      const { data, error } = await this.bucket(this.env.POSTER_BUCKET).download(p.storagePath);
      if (error || !data) throw new Error(error?.message ?? 'fichier vide');
      const buf = Buffer.from(await data.arrayBuffer());
      if (buf.length > MAX_POSTER_BYTES || !/^image\/(png|jpeg)$/.test(p.mime)) return null;
      return `data:${p.mime};base64,${buf.toString('base64')}`;
    } catch (e) {
      this.log.warn(`Affiche illisible (${p.storagePath}) : ${(e as Error).message} — artwork par défaut utilisé`);
      return null;
    }
  }

  async fileRow(ticketId: string, key: FileKindParam) {
    return this.prisma.generatedFile.findFirst({ where: { ticketId, kind: FILE_KINDS[key].kind, templateVersion: TEMPLATE_VERSION } });
  }

  /** URL signée de courte durée (bucket privé) ; nom de fichier de téléchargement lisible. null si pas encore généré. */
  async signedUrl(ticketId: string, key: FileKindParam, number?: string): Promise<{ url: string; expiresAt: Date; fileName: string; contentType: string } | null> {
    const row = await this.fileRow(ticketId, key);
    if (!row) return null;
    const k = FILE_KINDS[key];
    const num = number ?? (await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, select: { number: true } })).number;
    const fileName = `${k.prefix}-${num}.${k.ext}`;
    const ck = `${row.id}`;
    const hit = this.urlCache.get(ck);
    if (hit && hit.exp > Date.now() + 60_000) return { url: hit.url, expiresAt: new Date(hit.exp), fileName, contentType: k.mime };
    const { data, error } = await this.bucket(row.bucket).createSignedUrl(row.storagePath, SIGNED_TTL, { download: fileName });
    if (error || !data?.signedUrl) throw new Error(`URL signée impossible : ${error?.message}`);
    const exp = Date.now() + SIGNED_TTL * 1000;
    if (this.urlCache.size > 5000) this.urlCache.clear();
    this.urlCache.set(ck, { url: data.signedUrl, exp });
    return { url: data.signedUrl, expiresAt: new Date(exp), fileName, contentType: k.mime };
  }

  /** Pour la page de suivi de l'acheteur : les 3 liens de chaque billet, ou null tant que tout n'est pas généré. */
  async urlsFor(tickets: { id: string; number: string }[]): Promise<Map<string, TicketUrls>> {
    const out = new Map<string, TicketUrls>();
    if (!tickets.length) return out;
    const rows = await this.prisma.generatedFile.findMany({ where: { ticketId: { in: tickets.map((t) => t.id) }, templateVersion: TEMPLATE_VERSION }, select: { ticketId: true, kind: true } });
    const kinds = new Map<string, Set<FileKind>>();
    for (const r of rows) (kinds.get(r.ticketId!) ?? kinds.set(r.ticketId!, new Set()).get(r.ticketId!)!).add(r.kind);
    for (const t of tickets) {
      const k = kinds.get(t.id);
      if (!k || !k.has('TICKET_PDF') || !k.has('TICKET_IMAGE') || !k.has('SHARE_VISUAL')) continue;
      const [pdf, image, share] = await Promise.all((['pdf', 'image', 'share'] as const).map((x) => this.signedUrl(t.id, x, t.number)));
      if (pdf && image && share) out.set(t.id, { pdfUrl: pdf.url, imageUrl: image.url, shareVisualUrl: share.url });
    }
    return out;
  }

  async getBuffer(ticketId: string, key: FileKindParam): Promise<Buffer | null> {
    const row = await this.fileRow(ticketId, key);
    if (!row) return null;
    const { data, error } = await this.bucket(row.bucket).download(row.storagePath);
    if (error || !data) throw new Error(`Téléchargement ${key} impossible : ${error?.message}`);
    return Buffer.from(await data.arrayBuffer());
  }
}
