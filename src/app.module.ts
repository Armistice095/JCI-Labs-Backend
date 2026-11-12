import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { JobsModule } from './jobs/jobs.module';
import { RateLimitModule } from './common/rate-limit';
import { SalesModule } from './sales/sales.module';
import { TicketsModule } from './tickets/tickets.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health/health.controller';
import { OverviewModule } from './overview/overview.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { CheckinModule } from './checkin/checkin.module';
import { ParticipantsModule } from './participants/participants.module';
import { PrismaModule } from './prisma/prisma.module';
import { SupabaseModule } from './supabase/supabase.module';
import { TicketingModule } from './ticketing/ticketing.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [ConfigModule, RateLimitModule, PrismaModule, SupabaseModule, AuditModule, JobsModule, AuthModule, UsersModule, EventsModule, TicketingModule, TicketsModule, SalesModule, ParticipantsModule, OverviewModule, DashboardModule, CheckinModule],
  controllers: [HealthController],
})
export class AppModule {}
