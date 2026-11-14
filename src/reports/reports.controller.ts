import { Controller, Get, Param, ParseUUIDPipe, Req, Res, StreamableFile } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { RateLimit } from '../common/rate-limit';
import { ZodPipe } from '../common/zod.pipe';
import { ReportKind, reportKindParam } from './reports.schemas';
import { ReportsService } from './reports.service';

const uuid = new ParseUUIDPipe();

@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Les documents de l'onglet « Documents », avec ceux que l'utilisateur peut télécharger. */
  @Get('events/:eventId/reports')
  list(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string) { return this.reports.catalog(u, id); }

  /** Rapport PDF. Rendu par Chromium : limité à 20 par minute et par adresse IP. */
  @Get('events/:eventId/reports/:kind')
  @RateLimit('reports', 20, 60)
  async download(@CurrentUser() u: AuthUser, @Param('eventId', uuid) id: string, @Param('kind', new ZodPipe(reportKindParam)) kind: ReportKind,
                 @Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const f = await this.reports.generate(u, id, kind, req.ip);
    res.header('Cache-Control', 'private, no-store'); // noms, téléphones et recettes : jamais gardés par un cache partagé
    return new StreamableFile(f.buffer, { type: 'application/pdf', disposition: `attachment; filename="${f.fileName}"` });
  }
}
