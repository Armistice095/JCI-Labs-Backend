import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { OverviewService } from './overview.service';

@Controller()
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get('events/:eventId/overview')
  get(@CurrentUser() u: AuthUser, @Param('eventId', new ParseUUIDPipe()) id: string) { return this.overview.get(u, id); }
}
