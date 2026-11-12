import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { idempotencyKey } from '../sales/sales.schemas';
import { ScanBody, scanBody } from './checkin.schemas';
import { CheckinService } from './checkin.service';

const uuid = new ParseUUIDPipe();
const idem = new ZodPipe(idempotencyKey);

/**
 * Pas de limite de débit ici : toute l'équipe d'accueil partage souvent la même adresse IP (Wi-Fi de la salle) et peut scanner
 * plusieurs milliers de billets. La route est protégée par l'authentification et la permission `checkin.scan`.
 */
@Controller()
export class CheckinController {
  constructor(private readonly checkin: CheckinService) {}

  @Post('checkin/scan') @HttpCode(200) @RequirePermission('checkin.scan')
  scan(@CurrentUser() u: AuthUser, @Headers('idempotency-key') key: string | undefined, @Body(new ZodPipe(scanBody)) body: ScanBody) {
    return this.checkin.scan(u, body, idem.transform(key));
  }

  @Get('events/:eventId/checkin/stats')
  stats(@CurrentUser() u: AuthUser, @Param('eventId', uuid) eventId: string) { return this.checkin.stats(u, eventId); }
}
