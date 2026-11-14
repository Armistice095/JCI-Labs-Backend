import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { TicketsModule } from '../tickets/tickets.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({ imports: [EventsModule, TicketsModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
