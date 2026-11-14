import { Inject, Injectable, Logger } from '@nestjs/common';
import { imageSize } from 'image-size';
import { randomUUID } from 'node:crypto';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { conflict, invalidState, notFound, validation } from '../common/errors';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { EventAccess } from './event-access.service';
import { posterUrl } from './poster-url';
import { buildShareImage } from './share-image';

const MAX_POSTERS = 5;
const MAX_BYTES = 2 * 1024 * 1024;

function detectType(b: Buffer): { mime: string; ext: string } | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  return null;
}

@Injectable()
export class PostersService {
  private readonly log = new Logger(PostersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseAdminService,
    private readonly access: EventAccess,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get bucket() { return this.supabase.client.storage.from(this.env.POSTER_BUCKET); }

  private toDto(p: { id: string; storagePath: string; isCover: boolean; position: number; width: number | null; height: number | null }) {
    return { id: p.id, url: posterUrl(this.env, p.storagePath), isCover: p.isCover, position: p.position, width: p.width, height: p.height };
  }

  async upload(user: AuthUser, eventId: string, buffer: Buffer, wantCover: boolean) {
    await this.access.require(user, eventId, 'event.update');
    if (buffer.length > MAX_BYTES) throw validation('Fichier trop lourd (2 Mo maximum).');
    const type = detectType(buffer); // le type est déduit du contenu, pas du nom de fichier ni de l'en-tête
    if (!type) throw validation('Format non supporté : utilisez une image JPG ou PNG.');
    let dims: { width?: number; height?: number } = {};
    try { dims = imageSize(buffer); } catch { throw validation('Image illisible.'); }

    if ((await this.prisma.eventPoster.count({ where: { eventId } })) >= MAX_POSTERS) throw conflict(`Maximum ${MAX_POSTERS} affiches par événement.`);

    const storagePath = `${eventId}/${randomUUID()}.${type.ext}`;
    const { error } = await this.bucket.upload(storagePath, buffer, { contentType: type.mime, cacheControl: '31536000', upsert: false });
    if (error) { this.log.error(`upload: ${error.message}`); throw validation("Impossible d'enregistrer l'image."); }

    // Variante légère pour l'aperçu des liens partagés : si elle échoue, l'affiche est quand même enregistrée (l'aperçu utilisera l'original).
    const sharePath = await this.storeShareImage(storagePath, buffer, type.mime as 'image/png' | 'image/jpeg');

    try {
      const poster = await this.prisma.$transaction(async (tx) => {
        const count = await tx.eventPoster.count({ where: { eventId } });
        const isCover = wantCover || count === 0;
        if (isCover) await tx.eventPoster.updateMany({ where: { eventId }, data: { isCover: false } });
        return tx.eventPoster.create({
          data: { eventId, storagePath, sharePath, mime: type.mime, sizeBytes: buffer.length, width: dims.width ?? null, height: dims.height ?? null, position: count, isCover },
        });
      });
      await this.audit.log({ actorId: user.id, action: 'event.poster_add', entityType: 'event', entityId: eventId });
      return this.toDto(poster);
    } catch (e) {
      await this.bucket.remove([storagePath, ...(sharePath ? [sharePath] : [])]);
      throw e;
    }
  }

  /** Génère et envoie la variante d'aperçu (…-share.jpg à côté de l'original). Retourne son chemin, ou null en cas d'échec. */
  async storeShareImage(storagePath: string, original: Buffer, mime: 'image/png' | 'image/jpeg'): Promise<string | null> {
    const path = storagePath.replace(/\.[a-z]+$/, '-share.jpg');
    try {
      const jpeg = await buildShareImage(original, mime);
      const { error } = await this.bucket.upload(path, jpeg, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: true });
      if (error) throw new Error(error.message);
      return path;
    } catch (e) {
      this.log.warn(`Image d'aperçu non générée pour ${storagePath} : ${(e as Error).message}`);
      return null;
    }
  }

  async patch(user: AuthUser, eventId: string, posterId: string, data: { isCover?: boolean; position?: number }) {
    await this.access.require(user, eventId, 'event.update');
    const p = await this.prisma.eventPoster.findFirst({ where: { id: posterId, eventId } });
    if (!p) throw notFound('Affiche introuvable.');
    if (data.isCover === false && p.isCover) throw invalidState('Choisissez une autre affiche comme couverture.');
    const updated = await this.prisma.$transaction(async (tx) => {
      if (data.isCover) await tx.eventPoster.updateMany({ where: { eventId }, data: { isCover: false } });
      return tx.eventPoster.update({ where: { id: posterId }, data: { ...(data.isCover ? { isCover: true } : {}), ...(data.position !== undefined ? { position: data.position } : {}) } });
    });
    return this.toDto(updated);
  }

  async remove(user: AuthUser, eventId: string, posterId: string) {
    await this.access.require(user, eventId, 'event.update');
    const p = await this.prisma.eventPoster.findFirst({ where: { id: posterId, eventId } });
    if (!p) throw notFound('Affiche introuvable.');
    await this.prisma.$transaction(async (tx) => {
      await tx.eventPoster.delete({ where: { id: posterId } });
      if (p.isCover) {
        const next = await tx.eventPoster.findFirst({ where: { eventId }, orderBy: { position: 'asc' } });
        if (next) await tx.eventPoster.update({ where: { id: next.id }, data: { isCover: true } });
      }
    });
    const { error } = await this.bucket.remove([p.storagePath, ...(p.sharePath ? [p.sharePath] : [])]);
    if (error) this.log.warn(`Suppression du fichier ${p.storagePath} échouée : ${error.message}`);
    await this.audit.log({ actorId: user.id, action: 'event.poster_remove', entityType: 'event', entityId: eventId });
  }

  /** Suppression best-effort des fichiers d'un événement (utilisé à la suppression d'un brouillon). */
  async removeAllFiles(eventId: string) {
    const posters = await this.prisma.eventPoster.findMany({ where: { eventId }, select: { storagePath: true, sharePath: true } });
    if (!posters.length) return;
    const { error } = await this.bucket.remove(posters.flatMap((p) => [p.storagePath, ...(p.sharePath ? [p.sharePath] : [])]));
    if (error) this.log.warn(`Nettoyage des affiches de ${eventId} : ${error.message}`);
  }
}
