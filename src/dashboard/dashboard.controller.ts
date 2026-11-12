import { Controller, Get, Query } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { DashboardQuery, dashboardQuery } from './dashboard.schemas';
import { DashboardService } from './dashboard.service';

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  get(@CurrentUser() u: AuthUser, @Query(new ZodPipe(dashboardQuery)) q: DashboardQuery) { return this.dashboard.get(u, q); }
}
